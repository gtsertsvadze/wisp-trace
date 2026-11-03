// Weekly awards. Eligible agents: claimed (or seed), not deleted, >= RULES.BOARD_MIN_TASKS_AGENT tasks that week.
// Model / app awards also need >= BOARD_MIN_AGENTS_GROUP agents and >= BOARD_MIN_TASKS_GROUP tasks.
import type { Bindings } from '../env';
import type { AwardId, AwardRow, Outcome } from '../types';
import { RULES } from '../lib/rules';
import { taskType } from '../lib/taxonomy';
import { DAY, dayOf, dayStart, shiftWeek, weekEnd, weekLabel } from '../lib/time';

interface WeekRow {
  agent_id: string;
  name: string;
  is_seed: number;
  outcome: Outcome;
  task_type: string;
  task_kind: string;
  model: string;
  app: string;
  duration_s: number | null;
}

interface AgentWeek { id: string; name: string; seed: boolean; tasks: number; done: number; minutes: number; model: string; app: string }

const ELIGIBLE = "a.deleted_at IS NULL AND (a.claim_status = 'claimed' OR a.is_seed = 1)";
const rate = (done: number, n: number) => (n ? Math.round((done / n) * 1000) / 10 : 0); // 0-100, 1 decimal
const mins = (s: number | null) => Math.max(1, Math.ceil((s ?? 0) / 60));

async function weekRows(env: Bindings, week: string): Promise<WeekRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT t.agent_id, a.name, a.is_seed, t.outcome, t.task_type, t.task_kind, t.model, t.app, t.duration_s
     FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.week = ? AND ${ELIGIBLE}`,
  ).bind(week).all<WeekRow>();
  return results;
}

function perAgent(rows: WeekRow[]): Map<string, AgentWeek> {
  const m = new Map<string, AgentWeek & { models: Map<string, number>; apps: Map<string, number> }>();
  for (const r of rows) {
    let a = m.get(r.agent_id);
    if (!a) m.set(r.agent_id, (a = { id: r.agent_id, name: r.name, seed: !!r.is_seed, tasks: 0, done: 0, minutes: 0, model: '', app: '', models: new Map(), apps: new Map() }));
    a.tasks++;
    if (r.outcome === 'done') a.done++;
    a.minutes += mins(r.duration_s);
    a.models.set(r.model, (a.models.get(r.model) ?? 0) + 1);
    a.apps.set(r.app, (a.apps.get(r.app) ?? 0) + 1);
  }
  const top = (x: Map<string, number>) => [...x].sort((p, q) => q[1] - p[1])[0]?.[0] ?? '';
  return new Map([...m].map(([k, a]) => [k, { id: a.id, name: a.name, seed: a.seed, tasks: a.tasks, done: a.done, minutes: a.minutes, model: top(a.models), app: top(a.apps) }]));
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

/** Compute and store all awards for `week`. Returns the number of awards written. */
export async function computeAwards(env: Bindings, week: string, now = Date.now()): Promise<number> {
  const prevWeek = shiftWeek(week, -1);
  const lastDay = dayOf(weekEnd(week) - DAY);
  const [rowsAll, prevRows, dayRows] = await Promise.all([
    weekRows(env, week),
    weekRows(env, prevWeek),
    env.DB.prepare(
      `SELECT DISTINCT t.agent_id, t.day FROM traces t JOIN agents a ON a.id = t.agent_id
       WHERE t.day >= ? AND t.day <= ? AND ${ELIGIBLE}`,
    ).bind(dayOf(dayStart(lastDay) - 120 * DAY), lastDay).all<{ agent_id: string; day: string }>(),
  ]);

  const agentsAll = perAgent(rowsAll);
  const eligible = new Set([...agentsAll.values()].filter(a => a.tasks >= RULES.BOARD_MIN_TASKS_AGENT).map(a => a.id));
  const rows = rowsAll.filter(r => eligible.has(r.agent_id));
  const agents = [...agentsAll.values()].filter(a => eligible.has(a.id));
  const out: Omit<AwardRow, 'week' | 'computed_at'>[] = [];
  const agentAward = (award: AwardId, a: AgentWeek, value: number, detail: Record<string, unknown>) =>
    out.push({ award, subject_type: 'agent', subject: a.name, agent_id: a.id, value, detail_json: JSON.stringify({ seed: a.seed, model: a.model, app: a.app, week_label: weekLabel(week), ...detail }) });

  // hardest_working: most tasks (tie: better rate, more minutes)
  const hw = [...agents].sort((a, b) => b.tasks - a.tasks || b.done / b.tasks - a.done / a.tasks || b.minutes - a.minutes)[0];
  if (hw) agentAward('hardest_working', hw, hw.tasks, { tasks: hw.tasks, rate: rate(hw.done, hw.tasks), minutes: hw.minutes });

  // most_reliable_model: best success rate on the week's most common task kind
  const kinds = groupBy(rows, r => r.task_kind);
  const topKind = [...kinds].sort((a, b) => b[1].n - a[1].n)[0]?.[0];
  if (topKind) {
    const kindRows = rows.filter(r => r.task_kind === topKind);
    const types = groupBy(kindRows, r => r.task_type);
    const topType = [...types].sort((a, b) => b[1].n - a[1].n)[0]?.[0];
    const models = [...groupBy(kindRows, r => r.model)].filter(([, g]) => groupOk(g))
      .sort((a, b) => b[1].done / b[1].n - a[1].done / a[1].n || b[1].n - a[1].n);
    const best = models[0];
    if (best) {
      const [model, g] = best;
      const tt = taskType(topType);
      out.push({
        award: 'most_reliable_model', subject_type: 'model', subject: model, agent_id: null, value: rate(g.done, g.n),
        detail_json: JSON.stringify({
          kind: topKind, trend: tt.trend, type_label: tt.label, tasks: g.n, rate: rate(g.done, g.n), agents: g.agents.size,
          runner_up: models[1] ? { model: models[1][0], rate: rate(models[1][1].done, models[1][1].n) } : null,
          week_label: weekLabel(week),
        }),
      });
    }
  }

  // comeback: biggest success-rate gain vs previous week, >= 5 tasks both weeks
  const prev = perAgent(prevRows);
  const comebacks = agents
    .map(a => ({ a, p: prev.get(a.id) }))
    .filter((x): x is { a: AgentWeek; p: AgentWeek } => !!x.p && x.p.tasks >= 5 && x.a.tasks >= 5)
    .map(x => ({ ...x, gain: rate(x.a.done, x.a.tasks) - rate(x.p.done, x.p.tasks) }))
    .filter(x => x.gain > 0)
    .sort((x, y) => y.gain - x.gain || y.a.tasks - x.a.tasks);
  const cb = comebacks[0];
  if (cb) {
    agentAward('comeback', cb.a, Math.round(cb.gain * 10) / 10, {
      tasks: cb.a.tasks, rate: rate(cb.a.done, cb.a.tasks), prev_tasks: cb.p.tasks, prev_rate: rate(cb.p.done, cb.p.tasks),
      gain: Math.round(cb.gain * 10) / 10, minutes: cb.a.minutes,
    });
  }

  // top_app: best success rate among apps meeting the group thresholds
  const apps = [...groupBy(rows, r => r.app)].filter(([, g]) => groupOk(g))
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
    if (!eligible.has(r.agent_id)) continue;
    const s = days.get(r.agent_id) ?? new Set<string>();
    s.add(r.day);
    days.set(r.agent_id, s);
  }
  let best: { a: AgentWeek; streak: number } | null = null;
  for (const a of agents) {
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
