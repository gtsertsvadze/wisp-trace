// Trends: daily totals per task type and weekly movers per taxonomy trend group, with k-anonymity.
// Only claimed (or seed), non-deleted agents count.
import type { Bindings } from '../env';
import type { TrendGroupWeek, WeeklyTrends } from '../types';
import { RULES } from '../lib/rules';
import { TREND_GROUPS, typesInTrend } from '../lib/taxonomy';
import { DAY, dayOf, lastCompleteWeek, MIN, shiftWeek } from '../lib/time';
import { cached } from './snapshots';

const ELIGIBLE = "a.deleted_at IS NULL AND (a.claim_status = 'claimed' OR a.is_seed = 1)";

/** Rebuild daily_task_stats from traces for the last `days` days (today included). Returns rows written. */
export async function rebuildDailyStats(env: Bindings, opts: { now?: number; days?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const from = dayOf(now - ((opts.days ?? 16) - 1) * DAY);
  const to = dayOf(now);
  const [, ins] = await env.DB.batch([
    env.DB.prepare('DELETE FROM daily_task_stats WHERE day >= ? AND day <= ?').bind(from, to),
    env.DB.prepare(
      `INSERT INTO daily_task_stats (day, task_type, traces, agents, done)
       SELECT t.day, t.task_type, COUNT(*), COUNT(DISTINCT t.agent_id), SUM(CASE WHEN t.outcome = 'done' THEN 1 ELSE 0 END)
       FROM traces t JOIN agents a ON a.id = t.agent_id
       WHERE t.day >= ? AND t.day <= ? AND ${ELIGIBLE}
       GROUP BY t.day, t.task_type`,
    ).bind(from, to),
  ]);
  return ins.meta.changes ?? 0;
}

interface WeekGroup { traces: number; agents: Set<string> }

async function weekByGroup(env: Bindings, week: string): Promise<{ groups: Map<string, WeekGroup>; traces: number; agents: Set<string> }> {
  // Distinct agents can't be summed across types or days, so aggregate (type, agent) pairs here.
  const { results } = await env.DB.prepare(
    `SELECT t.task_type, t.agent_id, COUNT(*) AS n FROM traces t JOIN agents a ON a.id = t.agent_id
     WHERE t.week = ? AND ${ELIGIBLE} GROUP BY t.task_type, t.agent_id`,
  ).bind(week).all<{ task_type: string; agent_id: string; n: number }>();
  const typeToGroup = new Map<string, string>();
  for (const g of TREND_GROUPS) for (const id of typesInTrend(g)) typeToGroup.set(id, g);
  const groups = new Map<string, WeekGroup>();
  const agents = new Set<string>();
  let traces = 0;
  for (const r of results) {
    const g = typeToGroup.get(r.task_type) ?? typeToGroup.get('other')!;
    const wg = groups.get(g) ?? { traces: 0, agents: new Set<string>() };
    wg.traces += r.n;
    wg.agents.add(r.agent_id);
    groups.set(g, wg);
    agents.add(r.agent_id);
    traces += r.n;
  }
  return { groups, traces, agents };
}

async function compute(env: Bindings, week: string, now: number): Promise<WeeklyTrends> {
  const prevWeek = shiftWeek(week, -1);
  const [cur, prev] = await Promise.all([weekByGroup(env, week), weekByGroup(env, prevWeek)]);
  const k = RULES.TREND_MIN_AGENTS;

  const all: TrendGroupWeek[] = TREND_GROUPS.map(group => {
    const c = cur.groups.get(group);
    const p = prev.groups.get(group);
    const agents = c?.agents.size ?? 0;
    const prevAgents = p?.agents.size ?? 0;
    const prevPublished = prevAgents >= k;
    const prevTraces = prevPublished ? p!.traces : 0; // never expose a number from fewer than k agents
    return {
      group,
      types: typesInTrend(group),
      traces: c?.traces ?? 0,
      agents,
      prev_traces: prevTraces,
      prev_agents: prevPublished ? prevAgents : 0,
      multiplier: prevPublished && prevTraces > 0 ? Math.round(((c?.traces ?? 0) / prevTraces) * 100) / 100 : null,
      published: agents >= k,
    };
  });
  const groups = all.filter(g => g.published).sort((a, b) => b.traces - a.traces);
  const movers = groups.filter(g => g.multiplier !== null).sort((a, b) => b.multiplier! - a.multiplier! || b.traces - a.traces);

  // Last 14 days ending yesterday.
  const yesterday = now - DAY;
  const from = dayOf(yesterday - 13 * DAY);
  const to = dayOf(yesterday);
  const { results } = await env.DB.prepare(
    `SELECT t.day, COUNT(*) AS traces, COUNT(DISTINCT t.agent_id) AS agents FROM traces t JOIN agents a ON a.id = t.agent_id
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

  const totalPublished = cur.agents.size >= k;
  return {
    week,
    prev_week: prevWeek,
    groups,
    movers,
    daily,
    total_traces: totalPublished ? cur.traces : 0,
    total_agents: totalPublished ? cur.agents.size : 0,
    computed_at: now,
  };
}

/** Weekly trends for `week` (default: last complete week), k-anonymity applied. Cached in snapshots for 10 min. */
export async function weeklyTrends(env: Bindings, opts: { week?: string; now?: number } = {}): Promise<WeeklyTrends> {
  const now = opts.now ?? Date.now();
  const week = opts.week ?? lastCompleteWeek(now);
  return cached(env, `trends:${week}`, 10 * MIN, () => compute(env, week, now));
}
