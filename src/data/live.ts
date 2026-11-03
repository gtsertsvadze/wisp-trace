// Live feed + public stats (UI-1). Everything here is PublicFeedItem/PublicStats-level: no task text, URLs,
// trace ids or exact times ever leave this module. A task's specific name appears only once it is public
// (RULES.TASK_PUBLIC_MIN_CROWD different humans did it); before that the row says "Cancelled something".
import type { Bindings } from '../env';
import type { Outcome, PublicFeedItem, PublicStats } from '../types';
import { opaqueKey } from '../lib/ids';
import { minsFromSeconds } from '../lib/format';
import { RULES } from '../lib/rules';
import { isoWeek, lastCompleteWeek, MIN } from '../lib/time';
import { cached } from '../processing/snapshots';
import { TASK_COLS, isPublicTask, publicDone, taskOf, type TaskCols } from '../processing/tasks';
import { weeklyTrends } from '../processing/trends';

/** Only claimed (incl. seed), non-deleted agents feed public pages. Requires `agents a`. */
export const ELIGIBLE = "a.deleted_at IS NULL AND (a.claim_status = 'claimed' OR a.is_seed = 1)";

export type FeedFilter = 'all' | 'done' | 'failed';
export const parseFilter = (s: string | undefined): FeedFilter => (s === 'done' || s === 'failed' ? s : 'all');
const FILTER_SQL: Record<FeedFilter, string> = { all: '', done: "AND t.outcome = 'done'", failed: "AND t.outcome != 'done'" };

/** Cursor = base36(feed_visible_at) + '-' + base36(rows already seen at that exact ms). Opaque and never a trace id. */
export function encodeCursor(visibleAt: number, seenAtSameMs: number): string {
  return `${Math.max(0, Math.trunc(visibleAt)).toString(36)}-${Math.max(0, seenAtSameMs).toString(36)}`;
}
export function decodeCursor(s: string | undefined | null): { at: number; seen: number } | null {
  if (!s || !/^[0-9a-z]{1,12}(-[0-9a-z]{1,4})?$/.test(s)) return null;
  const [a, b = '0'] = s.split('-');
  const at = parseInt(a!, 36);
  const seen = parseInt(b, 36);
  return Number.isFinite(at) && Number.isFinite(seen) ? { at, seen } : null;
}

interface FeedRow extends TaskCols {
  id: string;
  outcome: Outcome;
  ticks: string;
  steps_count: number;
  duration_s: number | null;
  model: string;
  app: string;
  is_seed: number;
  feed_visible_at: number;
}

export interface FeedPage { items: PublicFeedItem[]; cursor: string | null }

/** The line under a feed row's task name. */
export function taskNote(task: { crowd: number }): string {
  return isPublicTask(task)
    ? `${task.crowd} people's agents did this`
    : `name stays private until ${RULES.TASK_PUBLIC_MIN_CROWD} people's agents do it`;
}

function toItem(r: FeedRow, key: string): PublicFeedItem {
  const task = taskOf(r);
  return {
    key,
    task: publicDone(task),
    note: taskNote(task),
    public: isPublicTask(task),
    outcome: r.outcome,
    ticks: r.ticks ?? '',
    steps: r.steps_count,
    mins: minsFromSeconds(r.duration_s ?? 0),
    model: r.model,
    app: r.app,
    seed: r.is_seed === 1,
  };
}

/**
 * Newest-first public feed. `after` (an encodeCursor value) returns only rows that became visible after it.
 * Ties on feed_visible_at are ordered by id so a cursor's `seen` count can skip rows already delivered.
 */
export async function feedItems(
  env: Bindings,
  opts: { limit?: number; filter?: FeedFilter; after?: string | null; now?: number } = {},
): Promise<FeedPage> {
  const now = opts.now ?? Date.now();
  const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit ?? 40)));
  const filter = opts.filter ?? 'all';
  const cur = decodeCursor(opts.after);
  const cols = `t.id, t.outcome, t.ticks, t.steps_count, t.duration_s, t.model, t.app, t.is_seed, t.feed_visible_at, ${TASK_COLS}`;
  const base = `FROM traces t JOIN agents a ON a.id = t.agent_id JOIN tasks k ON k.id = t.task_id WHERE t.feed_visible_at <= ? AND ${ELIGIBLE} ${FILTER_SQL[filter]}`;
  let rows: FeedRow[];
  if (cur) {
    const { results } = await env.DB.prepare(
      `SELECT ${cols} ${base} AND t.feed_visible_at >= ? ORDER BY t.feed_visible_at DESC, t.id DESC LIMIT ?`,
    ).bind(now, cur.at, limit + cur.seen + 1).all<FeedRow>();
    // Drop the rows at the cursor's ms the client has already seen (they sort last, lowest ids first).
    const same = results.filter(r => r.feed_visible_at === cur.at).reverse().slice(0, cur.seen).map(r => r.id);
    rows = results.filter(r => !same.includes(r.id)).slice(0, limit);
  } else {
    const { results } = await env.DB.prepare(`SELECT ${cols} ${base} ORDER BY t.feed_visible_at DESC, t.id DESC LIMIT ?`)
      .bind(now, limit).all<FeedRow>();
    rows = results;
  }
  const salt = env.HASH_SALT ?? '';
  const items = await Promise.all(rows.map(async r => toItem(r, await opaqueKey(r.id, salt))));
  let cursor: string | null = null;
  if (rows.length) {
    const top = rows[0]!.feed_visible_at;
    cursor = encodeCursor(top, rows.filter(r => r.feed_visible_at === top).length + (cur && cur.at === top ? cur.seen : 0));
  } else if (cur) {
    cursor = encodeCursor(cur.at, cur.seen);
  } else {
    cursor = encodeCursor(now, 0);
  }
  return { items, cursor };
}

async function computeStats(env: Bindings, now: number): Promise<PublicStats> {
  const week = isoWeek(now);
  const [counter, agents, recent, wk, recipes, tasks, trends] = await Promise.all([
    env.DB.prepare("SELECT value FROM counters WHERE key = 'traces_total'").first<{ value: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM agents a WHERE a.deleted_at IS NULL AND a.claim_status = 'claimed'").first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.received_at > ? AND ${ELIGIBLE}`)
      .bind(now - 15 * MIN).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(t.outcome = 'done'), 0) AS done FROM traces t JOIN agents a ON a.id = t.agent_id
       WHERE t.week = ? AND ${ELIGIBLE}`,
    ).bind(week).first<{ n: number; done: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(r.status = 'trusted'), 0) AS trusted, COALESCE(SUM(r.status = 'forming'), 0) AS forming
       FROM recipes r JOIN tasks k ON k.id = r.task_id WHERE k.crowd >= ?`,
    ).bind(RULES.TASK_PUBLIC_MIN_CROWD).first<{ trusted: number; forming: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE crowd >= ?').bind(RULES.TASK_PUBLIC_MIN_CROWD).first<{ n: number }>(),
    weeklyTrends(env, { now }).catch(() => null),
  ]);
  const weekTasks = wk?.n ?? 0;
  const mover = trends?.movers[0];
  return {
    traces_total: counter?.value ?? 0,
    agents_total: agents?.n ?? 0,
    per_min: Math.round(((recent?.n ?? 0) / 15) * 10) / 10,
    week,
    week_tasks: weekTasks,
    week_success_rate: weekTasks ? Math.round(((wk?.done ?? 0) / weekTasks) * 100) : 0,
    recipes_trusted: recipes?.trusted ?? 0,
    recipes_forming: recipes?.forming ?? 0,
    tasks_public: tasks?.n ?? 0,
    top_mover: mover && mover.multiplier != null ? { label: mover.label, multiplier: mover.multiplier } : null,
  };
}

/** Site-wide public numbers, cached ~15 s. */
export function publicStats(env: Bindings, now = Date.now()): Promise<PublicStats> {
  return cached(env, 'public:stats', 15_000, () => computeStats(env, now));
}

/** The agent with the most tasks this week (falls back to last complete week), for "See an agent profile →". */
export function topAgentOfWeek(env: Bindings, now = Date.now()): Promise<string | null> {
  return cached(env, 'public:top-agent', MIN, async () => {
    for (const week of [isoWeek(now), lastCompleteWeek(now)]) {
      const r = await env.DB.prepare(
        `SELECT a.name, COUNT(*) AS n FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.week = ? AND ${ELIGIBLE}
         GROUP BY t.agent_id HAVING n >= ? ORDER BY a.is_seed ASC, n DESC LIMIT 1`,
      ).bind(week, RULES.BOARD_MIN_TASKS_AGENT).first<{ name: string; n: number }>();
      if (r) return r.name;
    }
    return null;
  });
}
