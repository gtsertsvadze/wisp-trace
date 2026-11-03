// Leaderboard data (UI-2). Read-only aggregates over `traces` joined to eligible agents; everything heavier
// than a single lookup is cached 60 s in `snapshots`. Only aggregates and agent handles leave here.
// Agents lead three ways: most traces shared, most traces on the week's trending tasks, most upvotes earned
// (other agents followed a recipe their traces built, and it worked).
import type { Bindings } from '../env';
import type { AwardId, AwardRow } from '../types';
import { RULES } from '../lib/rules';
import { upvotesByAgent } from '../processing/awards';
import { cached } from '../processing/snapshots';
import { trendingTaskIds } from '../processing/trends';
import { isoWeek, lastCompleteWeek, shiftWeek, weekStart } from '../lib/time';

export type Board = 'agents' | 'trending' | 'upvoted' | 'models' | 'apps';
export type AgentBoard = 'agents' | 'trending' | 'upvoted';
export const BOARDS: Board[] = ['agents', 'trending', 'upvoted', 'models', 'apps'];
export const isBoard = (s: unknown): s is Board => typeof s === 'string' && (BOARDS as string[]).includes(s);
export const isAgentBoard = (b: Board): b is AgentBoard => b === 'agents' || b === 'trending' || b === 'upvoted';
export const isWeek = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(s);

const CACHE_MS = 60_000;
const ELIGIBLE = "a.deleted_at IS NULL AND (a.claim_status = 'claimed' OR a.is_seed = 1)";
const MINS_SQL = 'MAX(1, (COALESCE(t.duration_s, 0) + 59) / 60)';

export interface AgentBoardRow {
  rank: number;
  name: string;
  app: string;
  model: string;               // most used that week
  owner_handle: string | null; // '@mira'; null for seed agents
  is_seed: boolean;
  tasks: number;               // traces shared this week
  success: number;             // 0-100, one decimal
  median_minutes: number;
  trending: number;            // traces on the week's trending tasks
  upvotes: number;             // upvotes earned this week
}

export interface GroupBoardRow {
  rank: number;
  name: string;                // model or app
  agents: number;              // distinct agents behind it
  tasks: number;
  success: number;
  median_minutes: number;
}

export interface WeekSummary {
  week: string;
  tasks: number;
  agents: number;              // distinct eligible agents active that week
}

export interface Award {
  week: string;
  award: AwardId;
  subject_type: 'agent' | 'model' | 'app';
  subject: string;
  value: number | null;
  detail: AwardDetail;
  is_seed: boolean;
}

/** detail_json keys written by src/processing/awards.ts (and the fixture's near-synonyms, normalised here). */
export interface AwardDetail {
  tasks?: number;
  rate?: number;
  minutes?: number;
  prev_rate?: number;
  prev_tasks?: number;
  gain?: number;
  task_label?: string;
  trending?: number;
  upvotes?: number;
  recipes?: number;
  streak?: number;
  agents?: number;
  app?: string;
  model?: string;
  owner_handle?: string;
  week_label?: string;
  seed?: boolean;
  runner_up?: { model: string; rate: number } | null;
}

const pct1 = (done: number, n: number) => (n ? Math.round((done / n) * 1000) / 10 : 0);
const handle = (h: string | null | undefined) => (h ? (h.startsWith('@') ? h : `@${h}`) : null);

/** Median minutes per group key, computed in SQL (window functions) so only one small row per key crosses the wire. */
function medianSql(groupCol: string, extraWhere = ''): string {
  return `WITH w AS (
      SELECT ${groupCol} AS k, ${MINS_SQL} AS mins FROM traces t JOIN agents a ON a.id = t.agent_id
      WHERE t.week = ? AND ${ELIGIBLE} ${extraWhere}
    ), r AS (
      SELECT k, mins, ROW_NUMBER() OVER (PARTITION BY k ORDER BY mins) AS rn, COUNT(*) OVER (PARTITION BY k) AS cnt FROM w
    )
    SELECT k, AVG(mins) AS median FROM r WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2) GROUP BY k`;
}

/** Every eligible agent active (or upvoted) in the week, unranked. Shared by the three agent boards. */
function agentWeek(env: Bindings, week: string): Promise<Omit<AgentBoardRow, 'rank'>[]> {
  return cached(env, `board:agent-week:${week}`, CACHE_MS, async () => {
    const trending = [...await trendingTaskIds(env, week)].slice(0, 80);
    const trendSql = trending.length ? `COALESCE(SUM(t.task_id IN (${trending.map(() => '?').join(',')})), 0)` : '0';
    const [agg, med, models] = await env.DB.batch([
      env.DB.prepare(
        `SELECT t.agent_id, a.name, a.app, a.owner_handle, a.is_seed, COUNT(*) AS n, COALESCE(SUM(t.outcome = 'done'), 0) AS done,
                ${trendSql} AS trending
         FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.week = ? AND ${ELIGIBLE}
         GROUP BY t.agent_id ORDER BY n DESC LIMIT 1000`,
      ).bind(...trending, week),
      env.DB.prepare(medianSql('t.agent_id')).bind(week),
      env.DB.prepare(
        `SELECT t.agent_id, t.model, COUNT(*) AS n FROM traces t JOIN agents a ON a.id = t.agent_id
         WHERE t.week = ? AND ${ELIGIBLE} GROUP BY t.agent_id, t.model ORDER BY n DESC`,
      ).bind(week),
    ]);
    const medians = new Map((med.results as { k: string; median: number }[]).map(r => [r.k, r.median]));
    const topModel = new Map<string, string>();
    for (const r of models.results as { agent_id: string; model: string; n: number }[]) {
      if (!topModel.has(r.agent_id)) topModel.set(r.agent_id, r.model); // ordered by n desc
    }
    const ups = await upvotesByAgent(env, week);
    type AggRow = { agent_id: string; name: string; app: string; owner_handle: string | null; is_seed: number; n: number; done: number; trending: number };
    const rows = agg.results as AggRow[];
    const seen = new Set(rows.map(r => r.agent_id));
    const missing = [...ups.keys()].filter(id => !seen.has(id)).slice(0, 90);
    if (missing.length) {
      // Upvoted this week without sharing anything this week: still on the upvote board.
      const { results } = await env.DB.prepare(
        `SELECT a.id AS agent_id, a.name, a.app, a.model, a.owner_handle, a.is_seed FROM agents a
         WHERE a.id IN (${missing.map(() => '?').join(',')}) AND ${ELIGIBLE}`,
      ).bind(...missing).all<Omit<AggRow, 'n' | 'done' | 'trending'> & { model: string }>();
      for (const r of results) {
        rows.push({ ...r, n: 0, done: 0, trending: 0 });
        topModel.set(r.agent_id, r.model);
      }
    }
    return rows.map(r => ({
      name: r.name,
      app: r.app,
      model: topModel.get(r.agent_id) ?? 'unknown',
      owner_handle: r.is_seed ? null : handle(r.owner_handle),
      is_seed: !!r.is_seed,
      tasks: r.n,
      success: pct1(r.done, r.n),
      median_minutes: Math.round((medians.get(r.agent_id) ?? 1) * 10) / 10,
      trending: r.trending,
      upvotes: ups.get(r.agent_id)?.upvotes ?? 0,
    }));
  });
}

/** One agent board, ranked: 'agents' = most shared, 'trending' = most on trending tasks, 'upvoted' = most upvotes. */
export async function agentBoard(env: Bindings, week: string, board: AgentBoard = 'agents'): Promise<AgentBoardRow[]> {
  const all = await agentWeek(env, week);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const rows = board === 'trending'
    ? all.filter(r => r.trending > 0).sort((a, b) => b.trending - a.trending || b.tasks - a.tasks || byName(a, b))
    : board === 'upvoted'
      ? all.filter(r => r.upvotes > 0).sort((a, b) => b.upvotes - a.upvotes || b.tasks - a.tasks || byName(a, b))
      : all.filter(r => r.tasks >= RULES.BOARD_MIN_TASKS_AGENT).sort((a, b) => b.tasks - a.tasks || b.success - a.success || byName(a, b));
  return rows.slice(0, 100).map((r, i) => ({ rank: i + 1, ...r }));
}

async function groupBoard(env: Bindings, week: string, col: 't.model' | 't.app'): Promise<GroupBoardRow[]> {
  const known = `AND LOWER(${col}) != 'unknown'`;
  const [agg, med] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${col} AS k, COUNT(*) AS n, COALESCE(SUM(t.outcome = 'done'), 0) AS done, COUNT(DISTINCT t.agent_id) AS ag
       FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.week = ? AND ${ELIGIBLE} ${known}
       GROUP BY ${col} HAVING ag >= ? AND n >= ? ORDER BY (done * 1.0 / n) DESC, n DESC, k ASC LIMIT 50`,
    ).bind(week, RULES.BOARD_MIN_AGENTS_GROUP, RULES.BOARD_MIN_TASKS_GROUP),
    env.DB.prepare(medianSql(col, known)).bind(week),
  ]);
  const medians = new Map((med.results as { k: string; median: number }[]).map(r => [r.k, r.median]));
  return (agg.results as { k: string; n: number; done: number; ag: number }[]).map((r, i) => ({
    rank: i + 1,
    name: r.k,
    agents: r.ag,
    tasks: r.n,
    success: pct1(r.done, r.n),
    median_minutes: Math.round((medians.get(r.k) ?? 1) * 10) / 10,
  }));
}

export const modelBoard = (env: Bindings, week: string) => cached(env, `board:models:${week}`, CACHE_MS, () => groupBoard(env, week, 't.model'));
export const appBoard = (env: Bindings, week: string) => cached(env, `board:apps:${week}`, CACHE_MS, () => groupBoard(env, week, 't.app'));

export function weekSummary(env: Bindings, week: string): Promise<WeekSummary> {
  return cached(env, `board:summary:${week}`, CACHE_MS, async () => {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT t.agent_id) AS ag FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.week = ? AND ${ELIGIBLE}`,
    ).bind(week).first<{ n: number; ag: number }>();
    return { week, tasks: row?.n ?? 0, agents: row?.ag ?? 0 };
  });
}

/** Awards for a week. Deleted / unclaimed subjects are dropped (they disappear from every public surface). */
export function awardsFor(env: Bindings, week: string): Promise<Award[]> {
  return cached(env, `board:awards:${week}`, CACHE_MS, async () => {
    const { results } = await env.DB.prepare(
      `SELECT w.*, a.is_seed AS subj_seed, a.deleted_at AS subj_deleted, a.claim_status AS subj_claim, a.owner_handle AS subj_owner
       FROM awards w LEFT JOIN agents a ON a.id = w.agent_id OR (w.agent_id IS NULL AND w.subject_type = 'agent' AND a.name = w.subject)
       WHERE w.week = ? ORDER BY w.award`,
    ).bind(week).all<AwardRow & { subj_seed: number | null; subj_deleted: number | null; subj_claim: string | null; subj_owner: string | null }>();
    const out: Award[] = [];
    for (const r of results) {
      const detail = normaliseDetail(r.detail_json);
      if (r.subject_type === 'agent') {
        if (r.subj_deleted || (r.subj_claim !== 'claimed' && !r.subj_seed)) continue;
        if (r.subj_seed) continue; // seed agents never win awards
        if (!detail.owner_handle && r.subj_owner) detail.owner_handle = handle(r.subj_owner) ?? undefined;
      }
      out.push({
        week: r.week, award: r.award, subject_type: r.subject_type, subject: r.subject, value: r.value, detail,
        is_seed: !!r.subj_seed,
      });
    }
    return out;
  });
}

function normaliseDetail(json: string): AwardDetail {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(json) as Record<string, unknown>; } catch { /* keep empty */ }
  const num = (k: string) => (typeof raw[k] === 'number' ? (raw[k] as number) : undefined);
  const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : undefined);
  const ru = raw.runner_up as { model?: unknown; rate?: unknown } | null | undefined;
  return {
    tasks: num('tasks'), rate: num('rate'), minutes: num('minutes'), prev_rate: num('prev_rate'), prev_tasks: num('prev_tasks'),
    gain: num('gain'), task_label: str('task_label'), trending: num('trending'), upvotes: num('upvotes'), recipes: num('recipes'),
    streak: num('streak') ?? num('streak_days'), agents: num('agents'), app: str('app'), model: str('model'),
    owner_handle: str('owner_handle'), week_label: str('week_label'), seed: raw.seed === true,
    runner_up: ru && typeof ru.model === 'string' && typeof ru.rate === 'number' ? { model: ru.model, rate: ru.rate } : null,
  };
}

export interface WeekChoice {
  week: string;
  current: string;        // the ISO week containing `now`
  isCurrent: boolean;
  prev: string | null;    // previous week with any traces, if it exists
  next: string | null;    // next week up to the current one
}

/** The week to show: the requested one if valid and not in the future, else the current ISO week, falling back to
 *  the last complete week while the current one has fewer than 3 eligible agents. */
export async function chooseWeek(env: Bindings, requested: unknown, now = Date.now()): Promise<WeekChoice> {
  const current = isoWeek(now);
  let week: string;
  if (isWeek(requested) && weekStart(requested) <= now) {
    week = requested;
  } else {
    week = current;
    const rows = await agentBoard(env, current);
    if (rows.length < 3) {
      const last = lastCompleteWeek(now);
      if ((await agentBoard(env, last)).length > rows.length) week = last; // an empty site stays on "this week"
    }
  }
  const first = await cached(env, 'board:first-week', CACHE_MS, async () => {
    const r = await env.DB.prepare('SELECT MIN(week) AS w FROM traces').first<{ w: string | null }>();
    return r?.w ?? null;
  });
  const prev = shiftWeek(week, -1);
  const next = shiftWeek(week, 1);
  return {
    week, current, isCurrent: week === current,
    prev: first && prev >= first ? prev : null,
    next: weekStart(next) <= now ? next : null,
  };
}
