// Weekly awards. Agent awards go to claimed, non-deleted, non-seed agents:
//   most_shared   most traces shared (>= RULES.BOARD_MIN_TASKS_AGENT)
//   trendsetter   most traces on the week's trending tasks
//   most_upvoted  most upvotes earned: other agents followed a recipe its traces built, and succeeded
//   longest_streak
// Model / app awards also need >= BOARD_MIN_AGENTS_GROUP agents and >= BOARD_MIN_TASKS_GROUP tasks; seed agents'
// traces count toward them (they are real traces).
import type { Bindings } from '../env';
import type { AwardId, AwardRow, Outcome } from '../types';
import { RULES } from '../lib/rules';
import { DAY, dayOf, dayStart, weekEnd, weekLabel } from '../lib/time';
import { trendingTaskIds } from './trends';

interface WeekRow {
  agent_id: string;
  name: string;
  is_seed: number;
  outcome: Outcome;
  task_id: string;
  model: string;
  app: string;
  duration_s: number | null;
}

interface AgentWeek { id: string; name: string; seed: boolean; tasks: number; done: number; minutes: number; trending: number; model: string; app: string }

const ELIGIBLE = "a.deleted_at IS NULL AND (a.claim_status = 'claimed' OR a.is_seed = 1)";
const rate = (done: number, n: number) => (n ? Math.round((done / n) * 1000) / 10 : 0); // 0-100, 1 decimal
const mins = (s: number | null) => Math.max(1, Math.ceil((s ?? 0) / 60));

function perAgent(rows: WeekRow[], trending: Set<string>): Map<string, AgentWeek> {
  const m = new Map<string, AgentWeek & { models: Map<string, number>; apps: Map<string, number> }>();
  for (const r of rows) {
    let a = m.get(r.agent_id);
    if (!a) m.set(r.agent_id, (a = { id: r.agent_id, name: r.name, seed: !!r.is_seed, tasks: 0, done: 0, minutes: 0, trending: 0, model: '', app: '', models: new Map(), apps: new Map() }));
    a.tasks++;
    if (r.outcome === 'done') a.done++;
    if (trending.has(r.task_id)) a.trending++;
    a.minutes += mins(r.duration_s);
    a.models.set(r.model, (a.models.get(r.model) ?? 0) + 1);
    a.apps.set(r.app, (a.apps.get(r.app) ?? 0) + 1);
  }
  const top = (x: Map<string, number>) => [...x].sort((p, q) => q[1] - p[1])[0]?.[0] ?? '';
  return new Map([...m].map(([k, a]) => [k, { id: a.id, name: a.name, seed: a.seed, tasks: a.tasks, done: a.done, minutes: a.minutes, trending: a.trending, model: top(a.models), app: top(a.apps) }]));
}

function groupBy(rows: WeekRow[], key: (r: WeekRow) => string) {
  const m = new Map<string, { n: number; done: number; agents: Set<string> }>();
  for (const r of rows) {
    const k = key(r);
    const g = m.get(k) ?? { n: 0, done: 0, agents: new Set<string>() };
    g.n++;
    if (r.outcome === 'done') g.done++;
    g.agents.add(r.agent_id);
    m.set(k, g);
  }
  return m;
}

const groupOk = (g: { n: number; agents: Set<string> }) => g.agents.size >= RULES.BOARD_MIN_AGENTS_GROUP && g.n >= RULES.BOARD_MIN_TASKS_GROUP;

/** Upvotes earned per agent in `week` (votes on recipes it contributed to, never its own). */
export async function upvotesByAgent(env: Bindings, week: string): Promise<Map<string, { upvotes: number; recipes: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT c.agent_id, COUNT(*) AS n, COUNT(DISTINCT u.recipe_id) AS recipes
     FROM upvotes u JOIN recipe_contributors c ON c.recipe_id = u.recipe_id AND c.agent_id != u.voter_id
     JOIN agents a ON a.id = c.agent_id
     WHERE u.week = ? AND ${ELIGIBLE} GROUP BY c.agent_id`,
  ).bind(week).all<{ agent_id: string; n: number; recipes: number }>();
  return new Map(results.map(r => [r.agent_id, { upvotes: r.n, recipes: r.recipes }]));
}

/** Compute and store all awards for `week`. Returns the number of awards written. */
export async function computeAwards(env: Bindings, week: string, now = Date.now()): Promise<number> {
  const lastDay = dayOf(weekEnd(week) - DAY);
  const [rowsRes, dayRows, trending, upvotes, taskRows] = await Promise.all([
    env.DB.prepare(
      `SELECT t.agent_id, a.name, a.is_seed, t.outcome, t.task_id, t.model, t.app, t.duration_s
       FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.week = ? AND ${ELIGIBLE}`,
    ).bind(week).all<WeekRow>(),
    env.DB.prepare(
      `SELECT DISTINCT t.agent_id, t.day FROM traces t JOIN agents a ON a.id = t.agent_id
       WHERE t.day >= ? AND t.day <= ? AND ${ELIGIBLE}`,
    ).bind(dayOf(dayStart(lastDay) - 120 * DAY), lastDay).all<{ agent_id: string; day: string }>(),
    trendingTaskIds(env, week, now),
    upvotesByAgent(env, week),
    env.DB.prepare(
      `SELECT k.id, k.label, k.crowd, k.sensitive, COUNT(*) AS n FROM traces t JOIN tasks k ON k.id = t.task_id
       WHERE t.week = ? AND k.crowd >= ? AND k.sensitive = 0 GROUP BY k.id ORDER BY n DESC LIMIT 200`,
    ).bind(week, RULES.TASK_PUBLIC_MIN_CROWD).all<{ id: string; label: string; crowd: number; sensitive: number; n: number }>(),
  ]);
  const rowsAll = rowsRes.results;
  const publicTasks = new Map(taskRows.results.map(t => [t.id, t.label]));

  const agentsAll = perAgent(rowsAll, trending);
  // Seed agents count toward model/app awards (their traces are real) but never win an agent award.
  const humans = [...agentsAll.values()].filter(a => !a.seed);
  const out: Omit<AwardRow, 'week' | 'computed_at'>[] = [];
  const agentAward = (award: AwardId, a: Pick<AgentWeek, 'id' | 'name' | 'seed' | 'model' | 'app'>, value: number, detail: Record<string, unknown>) =>
    out.push({ award, subject_type: 'agent', subject: a.name, agent_id: a.id, value, detail_json: JSON.stringify({ seed: a.seed, model: a.model, app: a.app, week_label: weekLabel(week), ...detail }) });

  // most_shared: most traces (tie: better rate, more minutes)
  const ms = humans.filter(a => a.tasks >= RULES.BOARD_MIN_TASKS_AGENT)
    .sort((a, b) => b.tasks - a.tasks || b.done / b.tasks - a.done / a.tasks || b.minutes - a.minutes)[0];
  if (ms) agentAward('most_shared', ms, ms.tasks, { tasks: ms.tasks, rate: rate(ms.done, ms.tasks), minutes: ms.minutes });

  // trendsetter: most traces on trending tasks; detail names its most frequent trending task (public, not sensitive)
  const ts = humans.filter(a => a.trending > 0).sort((a, b) => b.trending - a.trending || b.tasks - a.tasks)[0];
  if (ts) {
    const counts = new Map<string, number>();
    for (const r of rowsAll) if (r.agent_id === ts.id && trending.has(r.task_id) && publicTasks.has(r.task_id)) counts.set(r.task_id, (counts.get(r.task_id) ?? 0) + 1);
    const topTask = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    agentAward('trendsetter', ts, ts.trending, {
      trending: ts.trending, tasks: ts.tasks, rate: rate(ts.done, ts.tasks), task_label: topTask ? publicTasks.get(topTask) : undefined,
    });
  }

  // most_upvoted: needs no traces this week; votes come from other agents following its recipes
  const upAgents = [...upvotes].filter(([, v]) => v.upvotes > 0);
  if (upAgents.length) {
    const ids = upAgents.map(([id]) => id);
    const { results: info } = await env.DB.prepare(
      `SELECT id, name, is_seed, app, model FROM agents WHERE id IN (${ids.map(() => '?').join(',')}) AND is_seed = 0 AND deleted_at IS NULL AND claim_status = 'claimed'`,
    ).bind(...ids).all<{ id: string; name: string; is_seed: number; app: string; model: string }>();
    const best = info.map(a => ({ a, v: upvotes.get(a.id)! }))
      .sort((x, y) => y.v.upvotes - x.v.upvotes || y.v.recipes - x.v.recipes || x.a.name.localeCompare(y.a.name))[0];
    if (best) {
      const wk = agentsAll.get(best.a.id);
      agentAward('most_upvoted', { id: best.a.id, name: best.a.name, seed: false, model: wk?.model || best.a.model, app: wk?.app || best.a.app },
        best.v.upvotes, { upvotes: best.v.upvotes, recipes: best.v.recipes, tasks: wk?.tasks ?? 0 });
    }
  }

  // most_reliable_model: best success rate on the week's most delegated public task
  const topTask = taskRows.results[0];
  if (topTask) {
    const taskRowsOnly = rowsAll.filter(r => r.task_id === topTask.id);
    const models = [...groupBy(taskRowsOnly, r => r.model)].filter(([m, g]) => m.toLowerCase() !== 'unknown' && groupOk(g))
      .sort((a, b) => b[1].done / b[1].n - a[1].done / a[1].n || b[1].n - a[1].n);
    const best = models[0];
    if (best) {
      const [model, g] = best;
      out.push({
        award: 'most_reliable_model', subject_type: 'model', subject: model, agent_id: null, value: rate(g.done, g.n),
        detail_json: JSON.stringify({
          task_label: topTask.label, tasks: g.n, rate: rate(g.done, g.n), agents: g.agents.size,
          runner_up: models[1] ? { model: models[1][0], rate: rate(models[1][1].done, models[1][1].n) } : null,
          week_label: weekLabel(week),
        }),
      });
    }
  }

  // top_app: best success rate among apps meeting the group thresholds
  const apps = [...groupBy(rowsAll, r => r.app)].filter(([app, g]) => app.toLowerCase() !== 'unknown' && groupOk(g))
    .sort((a, b) => b[1].done / b[1].n - a[1].done / a[1].n || b[1].n - a[1].n);
  if (apps[0]) {
    const [app, g] = apps[0];
    out.push({
      award: 'top_app', subject_type: 'app', subject: app, agent_id: null, value: rate(g.done, g.n),
      detail_json: JSON.stringify({ tasks: g.n, rate: rate(g.done, g.n), agents: g.agents.size, week_label: weekLabel(week) }),
    });
  }

  // longest_streak: consecutive active days ending on the week's last day (or the day before)
  const days = new Map<string, Set<string>>();
  for (const r of dayRows.results) {
    const s = days.get(r.agent_id) ?? new Set<string>();
    s.add(r.day);
    days.set(r.agent_id, s);
  }
  let best: { a: AgentWeek; streak: number } | null = null;
  for (const a of humans) {
    const s = days.get(a.id);
    if (!s) continue;
    let d = dayStart(lastDay);
    if (!s.has(lastDay)) d -= DAY;
    let streak = 0;
    while (s.has(dayOf(d))) {
      streak++;
      d -= DAY;
    }
    if (streak >= 2 && (!best || streak > best.streak || (streak === best.streak && a.tasks > best.a.tasks))) best = { a, streak };
  }
  if (best) agentAward('longest_streak', best.a, best.streak, { streak: best.streak, tasks: best.a.tasks, rate: rate(best.a.done, best.a.tasks), minutes: best.a.minutes });

  const stmts = [
    env.DB.prepare('DELETE FROM awards WHERE week = ?').bind(week),
    ...out.map(x => env.DB.prepare(
      'INSERT INTO awards (week, award, subject_type, subject, agent_id, value, detail_json, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(week, x.award, x.subject_type, x.subject, x.agent_id, x.value, x.detail_json, now)),
  ];
  await env.DB.batch(stmts);
  return out.length;
}
