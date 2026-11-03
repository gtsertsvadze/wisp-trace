// Step normalisation. Nothing step-level is stored: ingest uses this for the tick strip and the sites, and the recipe
// builder and the owner view re-derive steps from the stored full trace (rawstore) whenever they need them.
import type { Outcome, Sensitive, StepResult, StepType } from '../types';
import { maskUrl } from '../lib/mask';
import { registrableDomain } from '../lib/normalize';

/** One normalised step of a (masked) trace. `sig` aligns the same control across different agents' traces. */
export interface NormStep {
  idx: number;
  type: StepType;
  action: string;          // <= 200 chars
  target: string | null;   // <= 120 chars
  path: string | null;     // URL path without query/fragment, <= 160 chars
  result: StepResult;
  error: string | null;    // <= 200 chars
  sig: string;
  sensitive: Sensitive | null;
}

/** The step fields read from a trace (wire format or stored JSON); anything else is ignored. */
export interface StepLike {
  type?: unknown; action?: unknown; target?: unknown; url?: unknown; result?: unknown; error?: unknown; sensitive?: unknown;
}

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

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);
const cap = (s: string | undefined | null, n: number): string | null => (s ? s.slice(0, n) : null);

/** Normalise a trace's steps (max `max`) and collect the registrable domains its step URLs visited. */
export function normalizeSteps(stepsIn: unknown, max = 500): { steps: NormStep[]; sites: string[] } {
  const steps: NormStep[] = [];
  const sites: string[] = [];
  if (!Array.isArray(stepsIn)) return { steps, sites };
  stepsIn.slice(0, max).forEach((raw, idx) => {
    const s: StepLike = typeof raw === 'string' ? { action: raw } : raw && typeof raw === 'object' ? raw as StepLike : {};
    const action = str(s.action), target = str(s.target), url = str(s.url), error = str(s.error);
    const actionFull = action || target || str(s.type) || 'step';
    const type = normalizeStepType(str(s.type), actionFull);
    const path = urlPath(url);
    if (url && /^https?:\/\//i.test(url)) {
      const d = registrableDomain(url);
      if (d && !sites.includes(d)) sites.push(d);
    }
    const tgt = cap(target, 120);
    const text = [action, target, error].filter(Boolean).join(' ').slice(0, 2000);
    steps.push({
      idx,
      type,
      action: actionFull.slice(0, 200),
      target: tgt,
      path,
      result: normalizeStepResult(str(s.result), error),
      error: cap(error, 200),
      sig: stepSig(type, tgt, path, actionFull),
      sensitive: inferSensitive(str(s.sensitive), type, text, path),
    });
  });
  return { steps, sites };
}
