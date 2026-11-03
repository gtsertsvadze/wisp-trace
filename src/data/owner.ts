// Owner-only data: the private view of one agent's traces (task text, site, exact times) and the deletes.
// Everything here is gated by an owner token upstream (src/lib/auth.ts agentByOwnerToken). Nothing from this
// module may be rendered on a public page.
import type { Bindings } from '../env';
import type { AgentRow, Outcome, TaskSource } from '../types';
import { randomString, sha256Hex } from '../lib/ids';
import { deleteRaw, getRaw } from '../lib/rawstore';
import { minsFromSeconds } from '../lib/format';
import { RULES } from '../lib/rules';
import { recountTasks } from '../processing/tasks';
import { DAY, dayOf, dayStart, isoWeek } from '../lib/time';

export const OWNER_PAGE_SIZE = 40;

export interface OwnerTotals {
  tasks: number;
  done: number;
  success_pct: number;
  minutes: number;
  cost_usd: number;
  week_tasks: number;
  streak: number;
  best_streak: number;
  first_trace_at: number | null;
  last_trace_at: number | null;
}

export interface OwnerTraceItem {
  id: string;
  received_at: number;
  occurred_at: number;
  started_at: number | null;
  ended_at: number | null;
  task_id: string;
  task: string;           // the specific task name, e.g. 'Cancel Netflix subscription' (the owner always sees it)
  task_public: boolean;   // shown by name on public pages yet
  task_crowd: number;     // different people's agents behind it
  task_source: TaskSource; // 'agent' (its own tag) | 'llm' | 'heuristic' (from the description) | 'recipe' (it followed one)
  task_sensitive: boolean; // the task counts as sensitive everywhere (category, or flagged by 2+ owners)
  sensitive: boolean;      // this trace was marked sensitive (by the agent or by you)
  task_text: string | null;
  site: string | null;
  sites: string[];
  outcome: Outcome;
  fail_reason: string | null;
  blocked_by_site: boolean;
  steps: number;
  ticks: string;
  mins: number;
  duration_s: number | null;
  cost: number | null;
  model: string;
  app: string;
  recipe_id: string | null;
  raw_bytes: number | null;
  has_raw: boolean;
  mask_client: number;
  mask_server: number;
}

export interface OwnerTraceDetail {
  trace: OwnerTraceItem;
  raw: unknown | null;     // the masked full trace JSON (rawstore), or null when it is missing
  raw_missing: boolean;    // a raw_key exists but the object is gone (or no raw_key at all)
}

interface TraceDbRow {
  id: string; received_at: number; occurred_at: number; started_at: number | null; ended_at: number | null;
  task_id: string; task_source: TaskSource; task_label: string; task_crowd: number; task_sens: number; sensitive: number; task_text: string | null; site: string | null; sites_json: string | null;
  outcome: Outcome; fail_reason: string | null; blocked_by_site: number; steps_count: number; ticks: string;
  duration_s: number | null; cost_usd: number | null; model: string; app: string; recipe_id: string | null;
  raw_key: string | null; raw_bytes: number | null; mask_client: number; mask_server: number;
}

const TRACE_COLS = `t.id, t.received_at, t.occurred_at, t.started_at, t.ended_at, t.task_id, t.task_source, k.label AS task_label,
  k.crowd AS task_crowd, k.sensitive AS task_sens, t.sensitive, t.task_text, t.site, t.sites_json, t.outcome, t.fail_reason, t.blocked_by_site, t.steps_count, t.ticks,
  t.duration_s, t.cost_usd, t.model, t.app, t.recipe_id, t.raw_key, t.raw_bytes, t.mask_client, t.mask_server`;
const FROM = 'FROM traces t JOIN tasks k ON k.id = t.task_id';

function parseSites(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function toItem(r: TraceDbRow): OwnerTraceItem {
  return {
    id: r.id,
    received_at: r.received_at,
    occurred_at: r.occurred_at,
    started_at: r.started_at,
    ended_at: r.ended_at,
    task_id: r.task_id,
    task: r.task_label,
    task_public: r.task_crowd >= RULES.TASK_PUBLIC_MIN_CROWD,
    task_crowd: r.task_crowd,
    task_source: r.task_source,
    task_sensitive: !!r.task_sens,
    sensitive: !!r.sensitive,
    task_text: r.task_text,
    site: r.site,
    sites: parseSites(r.sites_json),
    outcome: r.outcome,
    fail_reason: r.fail_reason,
    blocked_by_site: !!r.blocked_by_site,
    steps: r.steps_count,
    ticks: r.ticks,
    mins: minsFromSeconds(r.duration_s ?? 0),
    duration_s: r.duration_s,
    cost: r.cost_usd,
    model: r.model,
    app: r.app,
    recipe_id: r.recipe_id,
    raw_bytes: r.raw_bytes,
    has_raw: !!r.raw_key,
    mask_client: r.mask_client,
    mask_server: r.mask_server,
  };
}

// ---------------------------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------------------------
function streaks(days: string[], now: number): { current: number; best: number } {
  const set = new Set(days);
  let best = 0, run = 0, prev = -Infinity;
  for (const d of [...set].sort()) {
    const t = dayStart(d);
    run = t - prev === DAY ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  let cur = 0, t = dayStart(dayOf(now));
  if (!set.has(dayOf(t))) t -= DAY;
  while (set.has(dayOf(t))) { cur++; t -= DAY; }
  return { current: cur, best };
}

export async function ownerTotals(env: Bindings, agentId: string, now = Date.now()): Promise<OwnerTotals> {
  const [tot, days] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(outcome = 'done'), 0) AS done,
              COALESCE(SUM(MAX(1, (COALESCE(duration_s, 0) + 59) / 60)), 0) AS mins,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(week = ?), 0) AS week_tasks,
              MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at
       FROM traces WHERE agent_id = ?`,
    ).bind(isoWeek(now), agentId),
    env.DB.prepare('SELECT DISTINCT day FROM traces WHERE agent_id = ?').bind(agentId),
  ]);
  const t = (tot.results[0] ?? {}) as { n?: number; done?: number; mins?: number; cost?: number; week_tasks?: number; first_at?: number | null; last_at?: number | null };
  const n = t.n ?? 0, done = t.done ?? 0;
  const s = streaks((days.results as { day: string }[]).map(r => r.day), now);
  return {
    tasks: n,
    done,
    success_pct: n ? Math.round((done / n) * 100) : 0,
    minutes: t.mins ?? 0,
    cost_usd: t.cost ?? 0,
    week_tasks: t.week_tasks ?? 0,
    streak: s.current,
    best_streak: s.best,
    first_trace_at: t.first_at ?? null,
    last_trace_at: t.last_at ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// List (cursor = "<received_at>.<id>" of the last row shown; newest first)
// ---------------------------------------------------------------------------------------------
const CURSOR_RE = /^(\d{1,16})\.(tr_[a-z0-9]{20})$/;

export function parseCursor(cursor: string | null | undefined): { at: number; id: string } | null {
  const m = cursor ? CURSOR_RE.exec(cursor) : null;
  return m ? { at: Number(m[1]), id: m[2] } : null;
}

export async function listOwnerTraces(
  env: Bindings, agentId: string, opts: { cursor?: string | null; limit?: number } = {},
): Promise<{ items: OwnerTraceItem[]; cursor: string | null }> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? OWNER_PAGE_SIZE));
  const cur = parseCursor(opts.cursor);
  const stmt = cur
    ? env.DB.prepare(
      `SELECT ${TRACE_COLS} ${FROM} WHERE t.agent_id = ? AND (t.received_at < ? OR (t.received_at = ? AND t.id < ?))
       ORDER BY t.received_at DESC, t.id DESC LIMIT ?`,
    ).bind(agentId, cur.at, cur.at, cur.id, limit + 1)
    : env.DB.prepare(`SELECT ${TRACE_COLS} ${FROM} WHERE t.agent_id = ? ORDER BY t.received_at DESC, t.id DESC LIMIT ?`)
      .bind(agentId, limit + 1);
  const { results } = await stmt.all<TraceDbRow>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toItem),
    cursor: results.length > limit && last ? `${last.received_at}.${last.id}` : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------
export const isTraceId = (s: unknown): s is string => typeof s === 'string' && /^tr_[a-z0-9]{20}$/.test(s);

export async function getOwnerTrace(env: Bindings, agentId: string, traceId: string): Promise<OwnerTraceDetail | null> {
  if (!isTraceId(traceId)) return null;
  const row = await env.DB.prepare(`SELECT ${TRACE_COLS} ${FROM} WHERE t.id = ? AND t.agent_id = ?`).bind(traceId, agentId).first<TraceDbRow>();
  if (!row) return null;
  let raw: unknown | null = null;
  if (row.raw_key) {
    try {
      const text = await getRaw(env, row.raw_key);
      if (text) raw = JSON.parse(text);
    } catch {
      raw = null; // unreadable object: shown as missing, never as an error page
    }
  }
  return { trace: toItem(row), raw, raw_missing: raw == null };
}

// ---------------------------------------------------------------------------------------------
// Deletes. Each removes the raw object(s) (R2, or trace_raw without R2), the traces row(s) and the upvotes they cast, decrements
// counters.traces_total (never below 0), recounts the affected tasks (so a name drops back to private if its crowd shrinks)
// and marks the affected recipe groups dirty so the next cron rebuild drops the evidence.
// ---------------------------------------------------------------------------------------------
async function r2Delete(env: Bindings, keys: string[]): Promise<void> {
  try {
    await deleteRaw(env, keys);
  } catch {
    // The D1 rows go regardless; an orphaned masked object is unreachable without its row.
  }
}

function groupStatements(env: Bindings, groups: Map<string, number>): D1PreparedStatement[] {
  return [...groups].map(([grp, n]) =>
    env.DB.prepare('UPDATE recipe_groups SET dirty = 1, traces = MAX(0, traces - ?) WHERE grp = ?').bind(n, grp));
}

const counterDecrement = (env: Bindings, n: number) =>
  env.DB.prepare("UPDATE counters SET value = MAX(0, value - ?) WHERE key = 'traces_total'").bind(n);

/**
 * Mark (or unmark) one of the agent's traces sensitive. The task's name then never shows next to this agent's handle;
 * once 2 different owners flag the same task, it counts as sensitive everywhere. Returns false when it isn't this agent's.
 */
export async function setTraceSensitive(env: Bindings, agentId: string, traceId: string, sensitive: boolean): Promise<boolean> {
  if (!isTraceId(traceId)) return false;
  const row = await env.DB.prepare('SELECT task_id FROM traces WHERE id = ? AND agent_id = ?').bind(traceId, agentId).first<{ task_id: string }>();
  if (!row) return false;
  await env.DB.prepare('UPDATE traces SET sensitive = ? WHERE id = ? AND agent_id = ?').bind(sensitive ? 1 : 0, traceId, agentId).run();
  await recountTasks(env, [row.task_id]);
  return true;
}

/** Delete one trace. Returns false when it isn't this agent's. */
export async function deleteOwnerTrace(env: Bindings, agentId: string, traceId: string): Promise<boolean> {
  if (!isTraceId(traceId)) return false;
  const row = await env.DB.prepare('SELECT id, raw_key, recipe_group, task_id FROM traces WHERE id = ? AND agent_id = ?')
    .bind(traceId, agentId).first<{ id: string; raw_key: string | null; recipe_group: string | null; task_id: string }>();
  if (!row) return false;
  if (row.raw_key) await r2Delete(env, [row.raw_key]);
  const stmts = [
    env.DB.prepare('DELETE FROM upvotes WHERE trace_id = ?').bind(traceId),
    env.DB.prepare('DELETE FROM traces WHERE id = ? AND agent_id = ?').bind(traceId, agentId),
    counterDecrement(env, 1),
  ];
  if (row.recipe_group) stmts.push(...groupStatements(env, new Map([[row.recipe_group, 1]])));
  await env.DB.batch(stmts);
  await recountTasks(env, [row.task_id]);
  return true;
}

/** Delete every trace of the agent. Returns the number removed. */
export async function deleteAllOwnerTraces(env: Bindings, agentId: string): Promise<number> {
  const { results } = await env.DB.prepare('SELECT id, raw_key, recipe_group, task_id FROM traces WHERE agent_id = ?')
    .bind(agentId).all<{ id: string; raw_key: string | null; recipe_group: string | null; task_id: string }>();
  if (!results.length) return 0;
  await r2Delete(env, results.map(r => r.raw_key).filter((k): k is string => !!k));
  const groups = new Map<string, number>();
  for (const r of results) if (r.recipe_group) groups.set(r.recipe_group, (groups.get(r.recipe_group) ?? 0) + 1);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM upvotes WHERE voter_id = ?').bind(agentId),
    env.DB.prepare('DELETE FROM traces WHERE agent_id = ?').bind(agentId),
    counterDecrement(env, results.length),
    ...groupStatements(env, groups),
  ]);
  await recountTasks(env, results.map(r => r.task_id));
  return results.length;
}

/**
 * Delete the agent: all traces, then soft-delete the row and scramble both credential hashes so the api key
 * and every owner link stop working immediately. The name stays reserved (deleted agents 404 everywhere).
 */
export async function deleteOwnerAgent(env: Bindings, agent: AgentRow, now = Date.now()): Promise<{ traces: number }> {
  const traces = await deleteAllOwnerTraces(env, agent.id);
  const scrambleKey = await sha256Hex(`deleted:${agent.id}:${randomString(32)}`);
  const scrambleOwner = await sha256Hex(`deleted-owner:${agent.id}:${randomString(32)}`);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM recipe_requests WHERE agent_id = ?').bind(agent.id),
    env.DB.prepare('DELETE FROM recipe_contributors WHERE agent_id = ?').bind(agent.id),
    env.DB.prepare(
      `UPDATE agents SET deleted_at = ?, api_key_hash = ?, owner_token_hash = ?, owner_post_url = NULL WHERE id = ?`,
    ).bind(now, scrambleKey, scrambleOwner, agent.id),
  ]);
  return { traces };
}

// ---------------------------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------------------------
export const normClaimCode = (code: string): string | null => {
  const c = (code ?? '').trim().toLowerCase();
  return /^[a-z0-9]{2,8}-[a-z0-9]{2,12}$/.test(c) ? c : null;
};

/** The non-deleted agent behind a claim code, or null. */
export async function agentByClaimCode(env: Bindings, code: string): Promise<AgentRow | null> {
  const c = normClaimCode(code);
  if (!c) return null;
  return env.DB.prepare('SELECT * FROM agents WHERE claim_code = ? AND deleted_at IS NULL').bind(c).first<AgentRow>();
}

export async function traceCount(env: Bindings, agentId: string): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM traces WHERE agent_id = ?').bind(agentId).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Mark the agent claimed and store the hash of a fresh owner token. Conditional on it still being unclaimed,
 * so two racing verifications can't both win. Returns false if it lost the race.
 */
export async function markClaimed(
  env: Bindings, agentId: string, owner: { handle: string; platform: string; post_url: string }, token: string, now = Date.now(),
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE agents SET claim_status = 'claimed', claimed_at = ?, owner_handle = ?, owner_platform = ?, owner_post_url = ?,
       owner_token_hash = ? WHERE id = ? AND claim_status = 'unclaimed' AND deleted_at IS NULL`,
  ).bind(now, owner.handle, owner.platform, owner.post_url, await sha256Hex(token), agentId).run();
  return (res.meta?.changes ?? 0) > 0;
}
