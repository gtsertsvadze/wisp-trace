// Trace ingest: validate -> server mask pass -> derive -> store (R2 masked JSON + one D1 batch).
// Never log trace contents here: only ids, counts and error codes.
import { z } from 'zod';
import type { Bindings } from '../env';
import type { AgentRow, Outcome, Sensitive, StepResult, StepType, TraceStepRow } from '../types';
import { AGENT_TEXT } from '../lib/agent-text';
import { newId } from '../lib/ids';
import { maskDeep, maskUrl } from '../lib/mask';
import { deleteRaw, putRaw } from '../lib/rawstore';
import { normalizeApp, normalizeModel, registrableDomain } from '../lib/normalize';
import { hit } from '../lib/ratelimit';
import { RULES } from '../lib/rules';
import { taskType } from '../lib/taxonomy';
import { DAY, HOUR, MIN, dayOf, isoWeek } from '../lib/time';
import { classifyTask } from './classify';
import { reportBlocked } from './policies';

export interface IngestResult {
  ok: true;
  trace: { id: string; task_type: string; task_label: string; outcome: Outcome; steps: number; mins: number; site: string | null };
  masked_server: number;
}

export class IngestError extends Error {
  constructor(public status: 400 | 403 | 413 | 429, public code: string, public extra: Record<string, unknown> = {}) {
    super(code);
  }
}

// ---------------------------------------------------------------------------
// Lenient wire schema: coerce scalars, cap lengths, keep unknown fields (raw traces are kept in full).
// ---------------------------------------------------------------------------
const toStr = (v: unknown) =>
  v == null ? undefined : typeof v === 'number' || typeof v === 'boolean' ? String(v) : v;
const toNum = (v: unknown) =>
  typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
const toBool = (v: unknown) => v === true || v === 1 || v === 'true' || v === '1' || v === 'yes';

/** Optional string capped at `max` chars; non-strings that can't be coerced are dropped, not rejected. */
const optStr = (max: number) =>
  z.preprocess(toStr, z.string().optional()).catch(undefined).transform(s => (s === undefined ? undefined : s.slice(0, max)));
/** Required non-empty string capped at `max`. */
const reqStr = (max: number) =>
  z.preprocess(toStr, z.string().trim().min(1)).transform(s => s.slice(0, max));
const optNum = z.preprocess(toNum, z.number().finite().optional()).catch(undefined);
const optTime = z.union([z.string().max(64), z.number().finite()]).optional().catch(undefined);
/** Free text that may arrive as structured content (e.g. Anthropic content blocks): stringify, then cap. */
const content = (max: number) =>
  z.preprocess(v => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)), z.string())
    .transform(s => s.slice(0, max));

const StepSchema = z.preprocess(
  v => (typeof v === 'string' ? { action: v } : v),
  z.looseObject({
    type: optStr(40),
    action: optStr(4000),
    target: optStr(4000),
    url: optStr(4000),
    result: optStr(40),
    observation: optStr(4000),
    error: optStr(4000),
    model_response: optStr(4000),
    sensitive: optStr(20),
    at: optTime,
    duration_ms: optNum,
  }),
);

const MessageSchema = z.preprocess(
  v => (typeof v === 'string' ? { role: 'assistant', content: v } : v),
  z.looseObject({ role: optStr(40), content: content(50_000) }),
);

const TraceSchema = z.looseObject({
  schema: z.string().regex(/^wisptrace\.trace\/v1(\.\d+)*$/, 'expected "wisptrace.trace/v1"').optional(),
  client: z.looseObject({
    name: optStr(60),
    version: optStr(40),
    masked: z.preprocess(toBool, z.boolean()).optional(),
    mask_counts: z.record(z.string(), z.preprocess(toNum, z.number())).optional().catch(undefined),
  }).optional().catch(undefined),
  task: z.preprocess(
    v => (typeof v === 'string' ? { description: v } : v),
    z.looseObject({
      description: reqStr(2000),
      sites: z.preprocess(
        v => (typeof v === 'string' ? [v] : v),
        z.array(z.preprocess(toStr, z.string()).catch('')).optional(),
      ).catch(undefined).transform(xs => xs?.filter(Boolean).slice(0, 20).map(s => s.slice(0, 500))),
      type_hint: optStr(60),
    }),
  ),
  agent: z.looseObject({ app: optStr(80), app_version: optStr(40), model: optStr(120) }).optional().catch(undefined),
  started_at: optTime,
  ended_at: optTime,
  duration_s: optNum,
  outcome: z.preprocess(
    v => (typeof v === 'string' ? { status: v } : v),
    z.looseObject({
      status: reqStr(40),
      reason: optStr(2000),
      blocked_by_site: z.preprocess(toBool, z.boolean()).optional(),
    }),
  ),
  steps: z.array(StepSchema).min(1, 'a trace needs at least one step')
    .transform(xs => xs.slice(0, RULES.TRACE_MAX_STEPS)),
  messages: z.array(MessageSchema).optional().catch(undefined)
    .transform(xs => xs?.slice(0, RULES.TRACE_MAX_MESSAGES)),
  usage: z.looseObject({ cost_usd: optNum, input_tokens: optNum, output_tokens: optNum }).optional().catch(undefined),
  recipe_id: optStr(60),
});

type ParsedTrace = z.infer<typeof TraceSchema>;
type ParsedStep = ParsedTrace['steps'][number];

// ---------------------------------------------------------------------------
// Derivation helpers (exported for tests)
// ---------------------------------------------------------------------------
export function normalizeOutcome(status: string): Outcome {
  const s = status.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['success', 'succeeded', 'done', 'completed', 'complete', 'ok'].includes(s)) return 'done';
  if (['handed_back', 'handback', 'hand_back', 'handed_off', 'needs_human', 'escalated'].includes(s)) return 'handed_back';
  return 'failed';
}

const STEP_TYPES: Record<string, StepType> = {
  navigate: 'navigate', goto: 'navigate', go_to: 'navigate', open: 'navigate', visit: 'navigate', load: 'navigate', open_url: 'navigate', navigation: 'navigate',
  click: 'click', tap: 'click', press: 'click', button: 'click', double_click: 'click', hover: 'click',
  type: 'type', fill: 'type', input: 'type', enter: 'type', fill_form: 'type', keyboard: 'type', key: 'type',
  select: 'select', choose: 'select', pick: 'select', dropdown: 'select', check: 'select', toggle: 'select',
  read: 'read', extract: 'read', observe: 'read', screenshot: 'read', inspect: 'read', get_text: 'read', view: 'read', snapshot: 'read',
  search: 'search', query: 'search', find: 'search', web_search: 'search',
  scroll: 'scroll', wait: 'wait', sleep: 'wait', pause: 'wait',
  tool: 'tool', tool_call: 'tool', tool_use: 'tool', function: 'tool', function_call: 'tool', api: 'tool', bash: 'tool', exec: 'tool', fetch: 'tool', http: 'tool', code: 'tool',
  think: 'think', plan: 'think', reason: 'think', reasoning: 'think', reflect: 'think', thought: 'think',
  ask_human: 'ask_human', ask: 'ask_human', ask_user: 'ask_human', handoff: 'ask_human', hand_back: 'ask_human', confirm: 'ask_human', human: 'ask_human',
  other: 'other',
};

export function normalizeStepType(type: string | undefined, action: string): StepType {
  const t = (type ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (t && STEP_TYPES[t]) return STEP_TYPES[t];
  const a = action.trim().toLowerCase();
  if (/^(navigat|open|went to|go(ing)? to|visit|load)/.test(a)) return 'navigate';
  if (/^(click|tap|press)/.test(a)) return 'click';
  if (/^(typ|enter|fill|input)/.test(a)) return 'type';
  if (/^(select|chose|choos|pick|check|tick)/.test(a)) return 'select';
  if (/^search/.test(a)) return 'search';
  if (/^scroll/.test(a)) return 'scroll';
  if (/^wait/.test(a)) return 'wait';
  if (/^(ask|hand(ed)? (it )?back|confirm(ed)? with)/.test(a)) return 'ask_human';
  if (/^(read|look|check|extract|review|inspect|saw|observ)/.test(a)) return 'read';
  if (/^(think|plan|decid|reason)/.test(a)) return 'think';
  if (/^(call|run|ran|exec|invok|use[ds]? tool)/.test(a)) return 'tool';
  return 'other';
}

export function normalizeStepResult(result: string | undefined, error: string | undefined): StepResult {
  const r = (result ?? '').trim().toLowerCase();
  if (/^(retr|warn|partial|slow|recovered)/.test(r)) return 'retry';
  if (/^(fail|error|err|false|timeout|timed|blocked|no$)/.test(r)) return 'fail';
  if (r) return 'ok';
  return error ? 'fail' : 'ok';
}

/** Path part of a (masked) URL, <= 160 chars. Relative paths are accepted. */
export function urlPath(url: string | undefined): string | null {
  if (!url) return null;
  const abs = url.startsWith('/') ? `https://site.invalid${url}` : url;
  let masked: string;
  try { masked = maskUrl(abs); } catch { return null; }
  try {
    const p = new URL(masked).pathname;
    return p ? p.slice(0, 160) : null;
  } catch {
    const m = /^[a-z]+:\/\/[^/]+(\/[^?#]*)?/i.exec(masked);
    return m ? (m[1] || '/').slice(0, 160) : null;
  }
}

/** Collapse ids and numbers so the same control on different traces gets the same text. */
function sigText(s: string): string {
  return s.toLowerCase()
    .replace(/\[([a-z_]+)\]/g, ' $1 ')                        // [EMAIL] -> email
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, ' id ')        // uuids
    .replace(/\b(?=[a-z_-]*\d)[a-z0-9_-]{8,}\b/g, ' id ')       // long tokens containing digits
    .replace(/\d+/g, '#')
    .replace(/[^a-z#> ]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, 8).join('-')
    .slice(0, 60);
}

function pathPattern(path: string): string {
  const segs = path.toLowerCase().split('/').filter(Boolean).slice(0, 6).map(seg =>
    /\d/.test(seg) || seg.length > 24 || /^\[[a-z_]+\]$/.test(seg) || /^[0-9a-f-]{12,}$/.test(seg) ? ':id' : seg.replace(/[^a-z0-9._-]/g, ''));
  return `/${segs.join('/')}`.slice(0, 80);
}

export function stepSig(type: StepType, target: string | null, path: string | null, action: string): string {
  const useTarget = type !== 'navigate' && type !== 'scroll' && type !== 'wait';
  const t = useTarget && target ? sigText(target) : '';
  if (t) return `${type}:${t}`;
  if (path) return `${type}:${pathPattern(path)}`;
  return `${type}:${sigText(action).split('-').slice(0, 4).join('-')}`;
}

const PAYMENT_PATH = /\/(checkout\/)?(payment|pay|billing|card|wallet)s?(\/|$)/i;
const PAYMENT_FIELD = /\b(card( number)?|cvv|cvc|csc|security code|expiry|expiration|iban|sort code|account number|billing|payment)\b/i;
const CRED_FIELD = /\b(pass(word|code|phrase)?|pin|otp|2fa|mfa|one[- ]time|verification code|auth(entication)? code|api key|token)\b/i;
const PERSONAL_FIELD = /\b(e-?mail|phone|mobile|address|post ?code|zip|first name|last name|full name|surname|date of birth|dob|birthday|passport|ssn|national insurance)\b/i;

export function inferSensitive(
  given: string | undefined, type: StepType, text: string, path: string | null,
): Sensitive | null {
  const g = (given ?? '').trim().toLowerCase();
  if (g === 'credentials' || g === 'payment' || g === 'personal') return g;
  if (/\[(CARD|IBAN|ACCOUNT)\]/.test(text)) return 'payment';
  if (/\[SECRET\]/.test(text)) return 'credentials';
  const entering = type === 'type' || type === 'select';
  if (entering && CRED_FIELD.test(text)) return 'credentials';
  if (entering && PAYMENT_FIELD.test(text)) return 'payment';
  if (path && PAYMENT_PATH.test(path) && (entering || type === 'click')) return 'payment';
  if (entering && (PERSONAL_FIELD.test(text) || /\[(EMAIL|PHONE|ADDRESS|POSTCODE|NAME|DOB|SSN)\]/.test(text))) return 'personal';
  return null;
}

export function buildTicks(results: StepResult[], outcome: Outcome): string {
  let ticks = results.map(r => (r === 'ok' ? 'o' : r === 'retry' ? 'r' : 'f')).join('');
  if (outcome === 'failed' && ticks && !ticks.endsWith('f')) ticks = `${ticks.slice(0, -1)}f`;
  if (ticks.length > 60) ticks = ticks.slice(0, 59) + ticks.slice(-1);
  return ticks;
}

function parseTime(v: string | number | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (v > 1e12 && v < 1e14) return Math.round(v);    // epoch ms
    if (v > 1e9 && v < 1e11) return Math.round(v * 1000); // epoch s
    return null;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const cap = (s: string | undefined | null, n: number): string | null => (s ? s.slice(0, n) : null);

/** Thrown when the server masking pass is not working: ingest fails closed rather than store unmasked data. */
export class MaskingUnavailableError extends Error {
  constructor() { super('masking_unavailable'); }
}

let maskerOk: boolean | undefined;
/** Canary self-test of the server mask pass (once per isolate). */
function maskerWorks(): boolean {
  if (maskerOk === undefined) {
    try {
      const r = maskDeep({ note: 'reach me at canary.person@example.com', password: 'hunter2-canary' });
      maskerOk = r.total > 0 && !JSON.stringify(r.value).includes('canary.person@example.com');
    } catch {
      maskerOk = false;
    }
  }
  return maskerOk;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------
const STEP_COLS = 10;
const STEP_ROWS_PER_INSERT = 9; // 90 bound params per statement, under D1's 100 limit

/** Validate, mask (server pass), derive, store (R2 + D1). Throws IngestError on rejection. */
export async function ingestTrace(
  env: Bindings, agent: AgentRow, body: unknown, opts: { occurredAt?: number; ctx?: ExecutionContext } = {},
): Promise<IngestResult> {
  const origin = env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  if (agent.deleted_at) throw new IngestError(403, 'agent_deleted', { message: AGENT_TEXT.notices.deleted });
  if (agent.claim_status !== 'claimed') {
    throw new IngestError(403, 'not_claimed', {
      message: AGENT_TEXT.notices.not_claimed, claim_url: `${origin}/claim/${agent.claim_code}`,
    });
  }

  const receivedAt = Date.now();
  // Admin backfill (occurredAt given) is not rate limited: it replays history for one agent.
  if (opts.occurredAt == null) {
    const rl = await hit(env, `traces:${agent.id}`, RULES.TRACES_PER_HOUR, HOUR, receivedAt);
    if (!rl.ok) {
      throw new IngestError(429, 'rate_limited', {
        message: AGENT_TEXT.notices.rate_limited, retry_after_s: Math.max(1, Math.ceil((rl.resetAt - receivedAt) / 1000)),
      });
    }
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new IngestError(400, 'invalid_trace', { issues: ['body: expected a JSON object'] });
  }

  // Server mask pass over the WHOLE body first. Validation (which truncates strings) runs on the masked
  // value so a cut can never split a value before the masker sees it.
  if (!maskerWorks()) {
    console.error('ingest: server masking pass failed its self-test; refusing to store traces');
    throw new MaskingUnavailableError();
  }
  const masked = maskDeep(body);
  const parsed = TraceSchema.safeParse(masked.value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 12).map(i => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw new IngestError(400, 'invalid_trace', { issues });
  }
  const tr = parsed.data;
  // Query strings and fragments are dropped from every stored URL (they carry session ids and tokens).
  for (const s of tr.steps) if (s.url) s.url = maskUrl(s.url);
  if (tr.task.sites) tr.task.sites = tr.task.sites.map(s => (s.includes('://') ? maskUrl(s) : s.split(/[?#]/)[0]));

  const maskClient = Math.min(1e6, Object.values(tr.client?.mask_counts ?? {})
    .reduce((n, v) => n + (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0), 0));
  const maskServer = masked.total;

  // ---- derive ----
  const outcome = normalizeOutcome(tr.outcome.status);
  const blocked = !!tr.outcome.blocked_by_site;

  const stepsIn: ParsedStep[] = tr.steps;
  const steps: TraceStepRow[] = [];
  const traceId = newId('tr');
  const sites: string[] = [];
  const addSite = (d: string | null) => { if (d && !sites.includes(d)) sites.push(d); };
  for (const s of tr.task.sites ?? []) addSite(registrableDomain(s));

  stepsIn.forEach((s, idx) => {
    const actionFull = s.action || s.target || s.type || 'step';
    const type = normalizeStepType(s.type, actionFull);
    const path = urlPath(s.url);
    if (s.url && /^https?:\/\//i.test(s.url)) addSite(registrableDomain(s.url));
    const target = cap(s.target, 120);
    const result = normalizeStepResult(s.result, s.error);
    const text = [s.action, s.target, s.error].filter(Boolean).join(' ').slice(0, 2000);
    steps.push({
      trace_id: traceId,
      idx,
      type,
      action: actionFull.slice(0, 200),
      target,
      path,
      result,
      error: cap(s.error, 200),
      sig: stepSig(type, target, path, actionFull),
      sensitive: inferSensitive(s.sensitive, type, text, path),
    });
  });
  const site = sites[0] ?? null;

  const { task_type, classifier } = await classifyTask(env, {
    description: tr.task.description,
    sites,
    type_hint: tr.task.type_hint,
    steps: steps.map(s => ({ action: s.action, target: s.target })),
  });
  const tt = taskType(task_type);

  const ticks = buildTicks(steps.map(s => s.result), outcome);

  const startedAt = parseTime(tr.started_at);
  const endedAt = parseTime(tr.ended_at);
  let durationS: number | null = null;
  if (tr.duration_s != null && tr.duration_s >= 0) durationS = tr.duration_s;
  else if (startedAt != null && endedAt != null && endedAt >= startedAt) durationS = (endedAt - startedAt) / 1000;
  else {
    const ms = stepsIn.reduce((n, s) => n + (s.duration_ms != null && s.duration_ms > 0 ? s.duration_ms : 0), 0);
    if (ms > 0) durationS = ms / 1000;
  }
  if (durationS != null) durationS = Math.min(Math.round(durationS), 7 * 24 * 3600);
  const mins = Math.max(1, Math.ceil((durationS ?? 0) / 60));

  let occurredAt: number;
  if (opts.occurredAt != null && Number.isFinite(opts.occurredAt)) occurredAt = Math.round(opts.occurredAt);
  else if (endedAt != null && endedAt >= receivedAt - 8 * DAY && endedAt <= receivedAt + 5 * MIN) occurredAt = endedAt;
  else occurredAt = receivedAt;
  const delayS = RULES.FEED_DELAY_MIN_S + Math.random() * (RULES.FEED_DELAY_MAX_S - RULES.FEED_DELAY_MIN_S);
  const feedVisibleAt = (opts.occurredAt ?? receivedAt) + Math.round(delayS * 1000);

  const recipeGroup = site ? `${site}|${task_type}` : null;
  const recipeId = tr.recipe_id && /^rc_[a-z0-9]{20}$/.test(tr.recipe_id) ? tr.recipe_id : null;
  const model = tr.agent?.model ? normalizeModel(tr.agent.model) : agent.model || 'unknown';
  const app = tr.agent?.app ? normalizeApp(tr.agent.app) : agent.app || 'Unknown';
  const cost = tr.usage?.cost_usd != null && tr.usage.cost_usd >= 0 && tr.usage.cost_usd < 10_000
    ? Math.round(tr.usage.cost_usd * 1e6) / 1e6 : null;

  // ---- store: masked JSON (R2 when bound, else D1 trace_raw) ----
  const rawKey = `traces/${agent.id}/${traceId}.json`;
  const raw = JSON.stringify(tr);
  const rawBytes = new TextEncoder().encode(raw).byteLength;
  await putRaw(env, rawKey, raw);

  // ---- store: D1 (one batch) ----
  const db = env.DB;
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO traces (id, agent_id, received_at, started_at, ended_at, occurred_at, day, week, task_type, task_kind,
        task_text, site, sites_json, outcome, fail_reason, blocked_by_site, steps_count, ticks, duration_s, cost_usd,
        model, app, recipe_id, recipe_group, raw_key, raw_bytes, mask_client, mask_server, classifier, feed_visible_at, is_seed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      traceId, agent.id, receivedAt, startedAt, endedAt, occurredAt, dayOf(occurredAt), isoWeek(occurredAt), task_type, tt.kind,
      tr.task.description, site, sites.length ? JSON.stringify(sites) : null, outcome, cap(tr.outcome.reason, 300),
      blocked ? 1 : 0, steps.length, ticks, durationS, cost,
      model, app, recipeId, recipeGroup, rawKey, rawBytes, maskClient, maskServer, classifier, feedVisibleAt, agent.is_seed ? 1 : 0,
    ),
  ];
  for (let i = 0; i < steps.length; i += STEP_ROWS_PER_INSERT) {
    const chunk = steps.slice(i, i + STEP_ROWS_PER_INSERT);
    const values = chunk.map(() => `(${Array(STEP_COLS).fill('?').join(', ')})`).join(', ');
    stmts.push(db.prepare(
      `INSERT INTO trace_steps (trace_id, idx, type, action, target, path, result, error, sig, sensitive) VALUES ${values}`,
    ).bind(...chunk.flatMap(s => [s.trace_id, s.idx, s.type, s.action, s.target, s.path, s.result, s.error, s.sig, s.sensitive])));
  }
  if (recipeGroup && site) {
    stmts.push(db.prepare(
      `INSERT INTO recipe_groups (grp, site, task_type, dirty, traces, last_trace_at) VALUES (?, ?, ?, 1, 1, ?)
       ON CONFLICT(grp) DO UPDATE SET dirty = 1, traces = traces + 1,
         last_trace_at = MAX(COALESCE(last_trace_at, 0), excluded.last_trace_at)`,
    ).bind(recipeGroup, site, task_type, occurredAt));
  }
  stmts.push(db.prepare(
    `INSERT INTO counters (key, value) VALUES ('traces_total', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1`,
  ));
  stmts.push(db.prepare('UPDATE agents SET last_seen_at = ?, model = ?, app = ? WHERE id = ?')
    .bind(receivedAt, model, app, agent.id));

  try {
    await db.batch(stmts);
  } catch (err) {
    await deleteRaw(env, [rawKey]).catch(() => {});
    throw err;
  }

  if (blocked && site) {
    const p = reportBlocked(env, site, agent.id).catch(e =>
      console.error('ingest: reportBlocked failed', traceId, e instanceof Error ? e.message : 'error'));
    if (opts.ctx) {
      try { opts.ctx.waitUntil(p); } catch { await p; }
    } else {
      await p;
    }
  }

  return {
    ok: true,
    trace: { id: traceId, task_type, task_label: tt.label, outcome, steps: steps.length, mins, site },
    masked_server: maskServer,
  };
}
