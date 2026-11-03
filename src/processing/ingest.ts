// Trace ingest: validate -> server mask pass -> name the task -> store (masked full trace in rawstore + one D1 batch).
// Nothing step-level is stored: recipes are rebuilt from the full traces.
// Never log trace contents here: only ids, counts and error codes.
import { z } from 'zod';
import type { Bindings } from '../env';
import type { AgentRow, Outcome } from '../types';
import { AGENT_TEXT } from '../lib/agent-text';
import { newId } from '../lib/ids';
import { maskDeep, maskUrl } from '../lib/mask';
import { deleteRaw, putRaw } from '../lib/rawstore';
import { normalizeApp, normalizeModel, registrableDomain } from '../lib/normalize';
import { hit } from '../lib/ratelimit';
import { RULES } from '../lib/rules';
import { DAY, HOUR, MIN, dayOf, isoWeek } from '../lib/time';
import { reportBlocked } from './policies';
import { buildTicks, normalizeOutcome, normalizeSteps } from './steps';
import { findOrCreateTask, isNewToCrowd, isPublicTask, nameTrace } from './tasks';

export interface IngestResult {
  ok: true;
  trace: { id: string; outcome: Outcome; steps: number; mins: number; site: string | null };
  /** The specific task this trace counts toward. `public`: its name is shown on public pages yet. */
  task: { slug: string; label: string; source: 'agent' | 'llm' | 'heuristic'; public: boolean; crowd: number };
  /** Set when the trace followed a recipe and succeeded: the recipe's contributors got an upvote. */
  upvoted_recipe: string | null;
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
      tag: optStr(200),
      sites: z.preprocess(
        v => (typeof v === 'string' ? [v] : v),
        z.array(z.preprocess(toStr, z.string()).catch('')).optional(),
      ).catch(undefined).transform(xs => xs?.filter(Boolean).slice(0, 20).map(s => s.slice(0, 500))),
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


// Step helpers live in ./steps (re-exported for existing callers and tests).
export { buildTicks, inferSensitive, normalizeOutcome, normalizeStepResult, normalizeStepType, stepSig, urlPath } from './steps';

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

const RECIPE_ID = /^rc_[a-z0-9]{20}$/;

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

  // Admin backfill replays history: the trace counts as received when it happened.
  const receivedAt = opts.occurredAt != null && Number.isFinite(opts.occurredAt) ? Math.round(opts.occurredAt) : Date.now();
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
  const traceId = newId('tr');
  const { steps, sites: stepSites } = normalizeSteps(tr.steps, RULES.TRACE_MAX_STEPS);
  const sites: string[] = [];
  for (const d of [...(tr.task.sites ?? []).map(s => registrableDomain(s)), ...stepSites]) if (d && !sites.includes(d)) sites.push(d);
  const site = sites[0] ?? null;

  const { name, source } = await nameTrace(env, { tag: tr.task.tag, description: tr.task.description, site });
  const task = await findOrCreateTask(env, name, source, site, receivedAt);
  const newToCrowd = await isNewToCrowd(env, task.id, agent);

  const ticks = buildTicks(steps.map(s => s.result), outcome);

  const startedAt = parseTime(tr.started_at);
  const endedAt = parseTime(tr.ended_at);
  let durationS: number | null = null;
  if (tr.duration_s != null && tr.duration_s >= 0) durationS = tr.duration_s;
  else if (startedAt != null && endedAt != null && endedAt >= startedAt) durationS = (endedAt - startedAt) / 1000;
  else {
    const ms = tr.steps.reduce((n, s) => n + (s.duration_ms != null && s.duration_ms > 0 ? s.duration_ms : 0), 0);
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

  const recipeGroup = site ? `${task.id}|${site}` : null;
  const recipeId = tr.recipe_id && RECIPE_ID.test(tr.recipe_id) ? tr.recipe_id : null;
  const model = tr.agent?.model ? normalizeModel(tr.agent.model) : agent.model || 'unknown';
  const app = tr.agent?.app ? normalizeApp(tr.agent.app) : agent.app || 'Unknown';
  const cost = tr.usage?.cost_usd != null && tr.usage.cost_usd >= 0 && tr.usage.cost_usd < 10_000
    ? Math.round(tr.usage.cost_usd * 1e6) / 1e6 : null;

  // ---- store: masked full trace (R2 when bound, else D1 trace_raw) ----
  const rawKey = `traces/${agent.id}/${traceId}.json`;
  const raw = JSON.stringify(tr);
  const rawBytes = new TextEncoder().encode(raw).byteLength;
  await putRaw(env, rawKey, raw);

  // ---- store: D1 (one batch) ----
  const db = env.DB;
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO traces (id, agent_id, received_at, started_at, ended_at, occurred_at, day, week, task_id, task_source,
        task_text, site, sites_json, outcome, fail_reason, blocked_by_site, steps_count, ticks, duration_s, cost_usd,
        model, app, recipe_id, recipe_group, raw_key, raw_bytes, mask_client, mask_server, feed_visible_at, is_seed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      traceId, agent.id, receivedAt, startedAt, endedAt, occurredAt, dayOf(occurredAt), isoWeek(occurredAt), task.id, source,
      tr.task.description, site, sites.length ? JSON.stringify(sites) : null, outcome, cap(tr.outcome.reason, 300),
      blocked ? 1 : 0, steps.length, ticks, durationS, cost,
      model, app, recipeId, recipeGroup, rawKey, rawBytes, maskClient, maskServer, feedVisibleAt, agent.is_seed ? 1 : 0,
    ),
    db.prepare('UPDATE tasks SET traces = traces + 1, crowd = crowd + ?, last_seen_at = MAX(last_seen_at, ?) WHERE id = ?')
      .bind(newToCrowd ? 1 : 0, occurredAt, task.id),
  ];
  if (recipeGroup && site) {
    stmts.push(db.prepare(
      `INSERT INTO recipe_groups (grp, task_id, site, dirty, traces, last_trace_at) VALUES (?, ?, ?, 1, 1, ?)
       ON CONFLICT(grp) DO UPDATE SET dirty = 1, traces = traces + 1,
         last_trace_at = MAX(COALESCE(last_trace_at, 0), excluded.last_trace_at)`,
    ).bind(recipeGroup, task.id, site, occurredAt));
  }
  // Implicit upvote: this agent followed someone else's recipe and it worked. One per (recipe, agent).
  const voteAt = recipeId && outcome === 'done' ? stmts.length : -1;
  if (voteAt >= 0) {
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO upvotes (recipe_id, voter_id, trace_id, at, week)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM recipes WHERE id = ?)
         AND NOT EXISTS (SELECT 1 FROM recipe_contributors WHERE recipe_id = ? AND agent_id = ?)`,
    ).bind(recipeId, agent.id, traceId, occurredAt, isoWeek(occurredAt), recipeId, recipeId, agent.id));
  }
  stmts.push(db.prepare(
    `INSERT INTO counters (key, value) VALUES ('traces_total', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1`,
  ));
  stmts.push(db.prepare('UPDATE agents SET last_seen_at = MAX(COALESCE(last_seen_at, 0), ?), model = ?, app = ? WHERE id = ?')
    .bind(receivedAt, model, app, agent.id));

  let upvoted: string | null = null;
  try {
    const res = await db.batch(stmts);
    if (voteAt >= 0 && (res[voteAt]?.meta.changes ?? 0) > 0) upvoted = recipeId;
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

  const crowd = task.crowd + (newToCrowd ? 1 : 0);
  return {
    ok: true,
    trace: { id: traceId, outcome, steps: steps.length, mins, site },
    task: { slug: task.slug, label: task.label, source, public: isPublicTask({ crowd }), crowd },
    upvoted_recipe: upvoted,
    masked_server: maskServer,
  };
}
