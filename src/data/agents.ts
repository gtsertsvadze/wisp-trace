// Agent profile data (UI-2). Public shape only: task names, ticks, counts and minutes. A profile is tied to its
// owner's handle, so a task's specific name shows only when it is public AND not sensitive (else "Cancelled
// something"). No task text, no URLs, no exact times (recent tasks are ordered but undated).
import type { Bindings } from '../env';
import type { AwardId, Outcome } from '../types';
import { opaqueKey } from '../lib/ids';
import { RULES } from '../lib/rules';
import { TASK_COLS, profileDone, taskOf, type TaskCols } from '../processing/tasks';
import { DAY, MIN, WEEK, dayOf, dayStart, isoWeek, weekStart } from '../lib/time';
import { type AwardDetail, awardsFor } from './boards';

export const ONLINE_WINDOW_MS = 45 * MIN;
export const GRID_WEEKS = 26;

export interface RecentTask {
  key: string;        // opaque, never the trace id
  task: string;       // 'Cancelled Netflix subscription', or 'Cancelled something' while private/sensitive
  outcome: Outcome;
  ticks: string;
  steps: number;
  mins: number;
  day: string;        // 'YYYY-MM-DD' (UTC): only used by the Atom feed, never shown on the page
}

export interface ActivityCell {
  day: string;
  count: number;      // -1 = in the future (not rendered)
  level: 0 | 1 | 2 | 3 | 4;
}

export interface BestAt { label: string; tasks: number; success: number }

export interface AgentAward {
  week: string;
  award: AwardId;
  title: string;
  detail: AwardDetail;
  value: number | null;
}

export interface AgentProfile {
  name: string;
  app: string;
  model: string;
  owner_handle: string | null;    // null for seed agents
  is_seed: boolean;
  online: boolean;
  last_seen_at: number | null;
  created_at: number;
  tasks: number;
  done: number;
  success: number;                // 0-100
  minutes: number;
  cost_usd: number;
  has_cost: boolean;              // false when no trace reported a cost
  streak: number;
  best_streak: number;
  activity: ActivityCell[];       // GRID_WEEKS * 7 cells, column-major from the Monday GRID_WEEKS-1 weeks ago
  personal_best: { day: string; count: number } | null;
  recent: RecentTask[];
  awards: AgentAward[];
  best_at: BestAt[];
  upvotes: number;                // all-time upvotes earned (other agents followed its recipes and succeeded)
  recipes: number;                // live recipes its traces helped build
}

const AWARD_TITLE: Record<AwardId, string> = {
  most_shared: 'Most traces shared',
  trendsetter: 'Trend-setter of the week',
  most_upvoted: 'Most upvoted',
  most_reliable_model: 'Most reliable model',
  top_app: 'Highest success · agent app',
  longest_streak: 'Longest streak',
};

interface AgentLite {
  id: string; name: string; app: string; model: string; claim_status: string; owner_handle: string | null;
  is_seed: number; created_at: number; last_seen_at: number | null; last_checkin_at: number | null; deleted_at: number | null;
}

/** Consecutive UTC days ending today or yesterday with >= 1 trace, and the longest such run ever. */
export function streaks(days: Iterable<string>, now: number): { current: number; best: number } {
  const set = new Set(days);
  let best = 0, run = 0, prev = NaN;
  for (const d of [...set].sort()) {
    const t = dayStart(d);
    run = t - prev === DAY ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  let current = 0, t = dayStart(dayOf(now));
  if (!set.has(dayOf(t))) t -= DAY;
  while (set.has(dayOf(t))) { current++; t -= DAY; }
  return { current, best };
}

/** 0 for no tasks, then quartiles of the nonzero day counts -> 1..4. */
export function activityLevels(byDay: Map<string, number>, now: number): ActivityCell[] {
  const nonzero = [...byDay.values()].filter(n => n > 0).sort((a, b) => a - b);
  const q = (p: number) => nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))] ?? 0;
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  const level = (n: number): ActivityCell['level'] => (n <= 0 ? 0 : n <= q1 ? 1 : n <= q2 ? 2 : n <= q3 ? 3 : 4);
  const start = weekStart(isoWeek(now)) - (GRID_WEEKS - 1) * WEEK;
  const today = dayStart(dayOf(now));
  return Array.from({ length: GRID_WEEKS * 7 }, (_, i) => {
    const t = start + i * DAY;
    const day = dayOf(t);
    if (t > today) return { day, count: -1, level: 0 };
    const count = byDay.get(day) ?? 0;
    return { day, count, level: level(count) };
  });
}

interface TraceTaskRow { id: string; outcome: Outcome; ticks: string; steps_count: number; duration_s: number | null; day: string }

async function findAgent(env: Bindings, name: string): Promise<AgentLite | null> {
  if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(name)) return null;
  const a = await env.DB.prepare(
    'SELECT id, name, app, model, claim_status, owner_handle, is_seed, created_at, last_seen_at, last_checkin_at, deleted_at FROM agents WHERE name = ?',
  ).bind(name).first<AgentLite>();
  if (!a || a.deleted_at) return null;
  if (!a.is_seed && a.claim_status !== 'claimed') return null; // profiles exist publicly only after consent
  return a;
}

export async function agentProfile(env: Bindings, name: string, now = Date.now()): Promise<AgentProfile | null> {
  const a = await findAgent(env, name);
  if (!a) return null;

  const [totals, days, recent, types, awardRows, votes, built] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(outcome = 'done'), 0) AS done,
              COALESCE(SUM(MAX(1, (COALESCE(duration_s, 0) + 59) / 60)), 0) AS mins,
              COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(cost_usd IS NOT NULL), 0) AS costed
       FROM traces WHERE agent_id = ?`,
    ).bind(a.id),
    env.DB.prepare('SELECT day, COUNT(*) AS c FROM traces WHERE agent_id = ? GROUP BY day').bind(a.id),
    env.DB.prepare(
      `SELECT t.id, t.outcome, t.ticks, t.steps_count, t.duration_s, t.day, ${TASK_COLS} FROM traces t JOIN tasks k ON k.id = t.task_id
       WHERE t.agent_id = ? AND t.feed_visible_at <= ? ORDER BY t.occurred_at DESC LIMIT 12`,
    ).bind(a.id, now),
    env.DB.prepare(
      `SELECT k.label, COUNT(*) AS n, COALESCE(SUM(t.outcome = 'done'), 0) AS done FROM traces t JOIN tasks k ON k.id = t.task_id
       WHERE t.agent_id = ? AND k.crowd >= ? AND k.sensitive = 0 GROUP BY t.task_id HAVING n >= 3 ORDER BY n DESC LIMIT 20`,
    ).bind(a.id, RULES.TASK_PUBLIC_MIN_CROWD),
    env.DB.prepare(
      "SELECT week, award, value FROM awards WHERE subject_type = 'agent' AND (agent_id = ? OR (agent_id IS NULL AND subject = ?)) ORDER BY week DESC",
    ).bind(a.id, a.name),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM upvotes u JOIN recipe_contributors c ON c.recipe_id = u.recipe_id AND c.agent_id = ? WHERE u.voter_id != ?`,
    ).bind(a.id, a.id),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM recipe_contributors c JOIN recipes r ON r.id = c.recipe_id JOIN tasks k ON k.id = r.task_id
       WHERE c.agent_id = ? AND r.status IN ('trusted', 'forming') AND k.crowd >= ?`,
    ).bind(a.id, RULES.TASK_PUBLIC_MIN_CROWD),
  ]);

  const tot = (totals.results[0] ?? { n: 0, done: 0, mins: 0, cost: 0, costed: 0 }) as { n: number; done: number; mins: number; cost: number; costed: number };
  const byDay = new Map((days.results as { day: string; c: number }[]).map(r => [r.day, r.c]));
  const st = streaks(byDay.keys(), now);

  let personal_best: AgentProfile['personal_best'] = null;
  for (const [day, count] of byDay) if (!personal_best || count > personal_best.count) personal_best = { day, count };

  const recentRows = recent.results as (TraceTaskRow & TaskCols)[];
  const recentTasks: RecentTask[] = await Promise.all(recentRows.map(async r => {
    return {
      key: await opaqueKey(r.id, env.HASH_SALT ?? ''),
      task: profileDone(taskOf(r), r.outcome), outcome: r.outcome, ticks: r.ticks ?? '',
      steps: r.steps_count, mins: Math.max(1, Math.ceil((r.duration_s ?? 0) / 60)), day: r.day,
    };
  }));

  const best_at: BestAt[] = (types.results as { label: string; n: number; done: number }[])
    .map(r => ({ label: r.label, tasks: r.n, success: Math.round((r.done / r.n) * 100) }))
    .sort((x, y) => y.success - x.success || y.tasks - x.tasks)
    .slice(0, 4);

  // Award details come from the cached per-week award list (same normalisation as the leaderboard column).
  const awards: AgentAward[] = [];
  for (const r of awardRows.results as { week: string; award: AwardId; value: number | null }[]) {
    const list = await awardsFor(env, r.week);
    const match = list.find(x => x.award === r.award && x.subject_type === 'agent' && x.subject === a.name);
    awards.push({ week: r.week, award: r.award, title: AWARD_TITLE[r.award] ?? r.award, detail: match?.detail ?? {}, value: r.value });
  }

  return {
    name: a.name, app: a.app, model: a.model,
    owner_handle: a.is_seed ? null : a.owner_handle ? (a.owner_handle.startsWith('@') ? a.owner_handle : `@${a.owner_handle}`) : null,
    is_seed: !!a.is_seed,
    online: a.last_seen_at != null && now - a.last_seen_at <= ONLINE_WINDOW_MS,
    last_seen_at: a.last_seen_at ?? a.last_checkin_at,
    created_at: a.created_at,
    tasks: tot.n, done: tot.done, success: tot.n ? Math.round((tot.done / tot.n) * 100) : 0,
    minutes: tot.mins, cost_usd: Math.round(tot.cost * 100) / 100, has_cost: tot.costed > 0,
    streak: st.current, best_streak: st.best,
    activity: activityLevels(byDay, now), personal_best,
    recent: recentTasks, awards, best_at,
    upvotes: (votes.results[0] as { n: number } | undefined)?.n ?? 0,
    recipes: (built.results[0] as { n: number } | undefined)?.n ?? 0,
  };
}

/** Feed entries: the last 30 visible tasks, dated at day granularity only. */
export async function agentFeedItems(env: Bindings, name: string, now = Date.now()): Promise<{ name: string; items: RecentTask[] } | null> {
  const a = await findAgent(env, name);
  if (!a) return null;
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.outcome, t.ticks, t.steps_count, t.duration_s, t.day, ${TASK_COLS} FROM traces t JOIN tasks k ON k.id = t.task_id
     WHERE t.agent_id = ? AND t.feed_visible_at <= ? ORDER BY t.occurred_at DESC LIMIT 30`,
  ).bind(a.id, now).all<TraceTaskRow & TaskCols>();
  const items = await Promise.all(results.map(async r => {
    return {
      key: await opaqueKey(r.id, env.HASH_SALT ?? ''),
      task: profileDone(taskOf(r), r.outcome), outcome: r.outcome, ticks: r.ticks ?? '',
      steps: r.steps_count, mins: Math.max(1, Math.ceil((r.duration_s ?? 0) / 60)), day: r.day,
    };
  }));
  return { name: a.name, items };
}
