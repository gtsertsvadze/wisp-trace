// Trends: weekly totals per specific task, with k-anonymity, week-over-week multipliers and "trending" flags.
// Only claimed (or seed), non-deleted agents count, and only tasks whose name is public. Every threshold counts different
// people (traces.owner_key), not agents. Sensitive tasks appear only by category ("Health & medical tasks").
import type { Bindings } from '../env';
import type { TrendTaskWeek, WeeklyTrends } from '../types';
import { RULES } from '../lib/rules';
import { SENSITIVE_LABEL } from '../lib/tasks';
import { DAY, dayOf, lastCompleteWeek, MIN, shiftWeek } from '../lib/time';
import { cached } from './snapshots';

const ELIGIBLE = "a.deleted_at IS NULL AND (a.claim_status = 'claimed' OR a.is_seed = 1)";
const MAX_TASKS = 200; // the snapshot keeps the biggest tasks plus every trending one

interface WeekTask { task_id: string; slug: string; label: string; traces: number; agents: number }

/** Sensitive tasks are grouped into one row per category, so no sensitive task is ever named in a trend. */
const GROUP_SQL = "CASE WHEN k.sensitive = 1 THEN 'cat:' || COALESCE(k.sensitive_kind, 'other') ELSE t.task_id END";

async function weekByTask(env: Bindings, week: string): Promise<{ tasks: Map<string, WeekTask>; traces: number; agents: number }> {
  const [byTask, tot] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${GROUP_SQL} AS task_id, MIN(k.slug) AS slug, MIN(k.label) AS label, COUNT(*) AS traces, COUNT(DISTINCT t.owner_key) AS agents
       FROM traces t JOIN agents a ON a.id = t.agent_id JOIN tasks k ON k.id = t.task_id
       WHERE t.week = ? AND ${ELIGIBLE} AND (k.crowd >= ? OR k.sensitive = 1)
       GROUP BY 1 HAVING agents >= ?`,
    ).bind(week, RULES.TASK_PUBLIC_MIN_CROWD, RULES.TREND_MIN_AGENTS),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT t.owner_key) AS ag FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.week = ? AND ${ELIGIBLE}`,
    ).bind(week),
  ]);
  const tasks = new Map((byTask.results as WeekTask[]).map(r => {
    const cat = r.task_id.startsWith('cat:') ? r.task_id.slice(4) : null;
    return [r.task_id, cat ? { ...r, slug: '', label: SENSITIVE_LABEL[cat] ?? SENSITIVE_LABEL.other! } : r];
  }));
  const t = (tot.results[0] ?? { n: 0, ag: 0 }) as { n: number; ag: number };
  return { tasks, traces: t.n, agents: t.ag };
}

async function compute(env: Bindings, week: string, now: number): Promise<WeeklyTrends> {
  const prevWeek = shiftWeek(week, -1);
  const [cur, prev] = await Promise.all([weekByTask(env, week), weekByTask(env, prevWeek)]);
  const k = RULES.TREND_MIN_AGENTS;

  // Every task in `cur` already passed k-anonymity; last week's number is used only if it passed too.
  const all: TrendTaskWeek[] = [...cur.tasks.values()].map(c => {
    const p = prev.tasks.get(c.task_id);
    return {
      task_id: c.task_id,
      slug: c.slug,
      label: c.label,
      traces: c.traces,
      agents: c.agents,
      prev_traces: p?.traces ?? 0,
      prev_agents: p?.agents ?? 0,
      // Growth on a tiny base is noise: last week needs RULES.TREND_MIN_BASE traces (and k people) to compare against.
      multiplier: p && p.traces >= RULES.TREND_MIN_BASE ? Math.round((c.traces / p.traces) * 100) / 100 : null,
      published: true,
      trending: false,
    };
  }).sort((a, b) => b.traces - a.traces || a.label.localeCompare(b.label));
  // Category rows (sensitive tasks) never trend: trending credits agents, and agents carry their owners' handles.
  all.filter(t => !t.task_id.startsWith('cat:')).forEach((t, i) => {
    t.trending = i < RULES.TRENDING_TOP || (t.multiplier ?? 0) >= RULES.TRENDING_MIN_MULTIPLIER;
  });
  const tasks = all.filter((t, i) => i < MAX_TASKS || t.trending);
  const movers = tasks.filter(t => t.multiplier !== null).sort((a, b) => b.multiplier! - a.multiplier! || b.traces - a.traces).slice(0, 50);

  // Last 14 days ending yesterday.
  const yesterday = now - DAY;
  const from = dayOf(yesterday - 13 * DAY);
  const to = dayOf(yesterday);
  const { results } = await env.DB.prepare(
    `SELECT t.day, COUNT(*) AS traces, COUNT(DISTINCT t.owner_key) AS agents FROM traces t JOIN agents a ON a.id = t.agent_id
     WHERE t.day >= ? AND t.day <= ? AND ${ELIGIBLE} GROUP BY t.day`,
  ).bind(from, to).all<{ day: string; traces: number; agents: number }>();
  const byDay = new Map(results.map(r => [r.day, r]));
  const daily: WeeklyTrends['daily'] = [];
  for (let i = 13; i >= 0; i--) {
    const day = dayOf(yesterday - i * DAY);
    const r = byDay.get(day);
    const published = (r?.agents ?? 0) >= k;
    daily.push({ day, traces: published ? r!.traces : 0, agents: published ? r!.agents : 0, published });
  }

  const totalPublished = cur.agents >= k;
  return {
    week,
    prev_week: prevWeek,
    tasks,
    movers,
    daily,
    total_traces: totalPublished ? cur.traces : 0,
    total_agents: totalPublished ? cur.agents : 0,
    computed_at: now,
  };
}

/** Weekly trends for `week` (default: last complete week), k-anonymity applied. Cached in snapshots for 10 min. */
export async function weeklyTrends(env: Bindings, opts: { week?: string; now?: number } = {}): Promise<WeeklyTrends> {
  const now = opts.now ?? Date.now();
  const week = opts.week ?? lastCompleteWeek(now);
  return cached(env, `trends:${week}`, 10 * MIN, () => compute(env, week, now));
}

/** Ids of the week's trending tasks (top by volume, or fast growers). Leaderboards and awards credit traces on them. */
export async function trendingTaskIds(env: Bindings, week: string, now = Date.now()): Promise<Set<string>> {
  const t = await weeklyTrends(env, { week, now });
  return new Set(t.tasks.filter(x => x.trending).map(x => x.task_id));
}
