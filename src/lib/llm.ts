// Optional LLM helper (Anthropic Messages API via plain fetch). Returns null when ANTHROPIC_API_KEY is unset,
// on any error, or when output fails validation — callers must always have a heuristic fallback.
// Never logs prompt or response contents.

import type { Bindings } from '../env';

export interface LlmJsonRequest {
  model?: 'fast' | 'smart';                 // fast = classification, smart = recipe synthesis
  system: string;
  user: string;
  schema: Record<string, unknown>;          // JSON Schema the output must satisfy
  maxTokens?: number;
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODELS = { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' } as const;
const TIMEOUT_MS = 20_000;
// Server-side refusal fallback (Claude API, Sonnet 5.5 supports only the "default" form).
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

type Attempt = { kind: 'ok'; value: unknown } | { kind: 'retry' } | { kind: 'fail' } | { kind: 'bad_request' };

export async function llmJson<T>(env: Bindings, req: LlmJsonRequest): Promise<T | null> {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const tier = req.model ?? 'fast';
  let withFallback = tier === 'smart';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await callOnce(key, tier, req, withFallback);
    if (r.kind === 'ok') return validate(r.value, req.schema) ? (r.value as T) : null;
    if (r.kind === 'fail') return null;
    // A 400 with the fallback beta on: retry once without it rather than losing the call.
    if (r.kind === 'bad_request') {
      if (!withFallback) return null;
      withFallback = false;
    }
  }
  return null;
}

async function callOnce(key: string, tier: 'fast' | 'smart', req: LlmJsonRequest, withFallback: boolean): Promise<Attempt> {
  const body: Record<string, unknown> = {
    model: MODELS[tier],
    max_tokens: req.maxTokens ?? (tier === 'smart' ? 8000 : 2000),
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    output_config: {
      effort: tier === 'smart' ? 'medium' : 'low',
      format: { type: 'json_schema', schema: req.schema },
    },
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };
  if (withFallback) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = FALLBACK_BETA;
  }
  let res: Response;
  try {
    res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { kind: 'retry' }; // network error or timeout
  }
  if (res.status === 429 || res.status === 408 || res.status === 409 || res.status >= 500) {
    console.warn('llm: upstream status', res.status);
    return { kind: 'retry' };
  }
  if (res.status === 400) {
    console.warn('llm: bad request');
    return { kind: 'bad_request' };
  }
  if (!res.ok) {
    console.warn('llm: upstream status', res.status);
    return { kind: 'fail' };
  }
  try {
    const msg = (await res.json()) as { stop_reason?: string; content?: { type: string; text?: string }[] };
    if (msg.stop_reason !== 'end_turn' && msg.stop_reason !== 'stop_sequence') return { kind: 'fail' }; // refusal, max_tokens…
    const text = (msg.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('');
    return { kind: 'ok', value: JSON.parse(text) };
  } catch {
    return { kind: 'fail' };
  }
}

/** Minimal JSON Schema check (type, properties, required, additionalProperties:false, items, enum, length/size bounds). */
export function validate(v: unknown, s: Record<string, unknown>): boolean {
  const type = s.type as string | string[] | undefined;
  if (type) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some(t => typeOk(v, t))) return false;
  }
  if (Array.isArray(s.enum) && !s.enum.some(e => e === v)) return false;
  if (typeof v === 'string') {
    if (typeof s.maxLength === 'number' && v.length > s.maxLength) return false;
    if (typeof s.minLength === 'number' && v.length < s.minLength) return false;
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) return false;
    if (typeof s.maximum === 'number' && v > s.maximum) return false;
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) return false;
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) return false;
    const items = s.items as Record<string, unknown> | undefined;
    if (items && !v.every(x => validate(x, items))) return false;
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const k of (s.required as string[] | undefined) ?? []) if (!(k in o)) return false;
    for (const [k, val] of Object.entries(o)) {
      if (props[k]) {
        if (!validate(val, props[k])) return false;
      } else if (s.additionalProperties === false) return false;
    }
  }
  return true;
}

function typeOk(v: unknown, t: string): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return !!v && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return true;
  }
}
