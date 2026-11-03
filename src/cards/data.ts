// Card data: our own read-only queries against the schema. Only aggregates and taxonomy labels leave here —
// never task text, never a trace's site (recipe cards show the recipe's site, which is public on /recipes).
import type { Bindings } from '../env';
import type { AwardId, AwardRow, RecipeRow, RecipeStatus, RecipeStep } from '../types';
import { RULES } from '../lib/rules';
import { taskType } from '../lib/taxonomy';
import { DAY, WEEK, ago, dayOf, dayStart, isoWeek, weekLabel, weekNumber, weekStart } from '../lib/time';
import { weeklyTrends } from '../processing/trends';
import type { AgentCardData, AwardCardData, BoardCardData, BoardRow, RecipeCardData, Stat, TrendCardData } from './svg';
import { fmtInt } from './svg';

const ELIGIBLE = "a.deleted_at IS NULL AND (a.claim_status = 'claimed' OR a.is_seed = 1)";
const MINS_SQL = 'MAX(1, (COALESCE(t.duration_s, 0) + 59) / 60)';

export const displayHost = (env: Bindings) => (env.PUBLIC_ORIGIN || 'https://wisptrace.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
export const origin = (env: Bindings) => (env.PUBLIC_ORIGIN || 'https://wisptrace.com').replace(/\/+$/, '');
const pct = (done: number, n: number) => (n ? Math.round((done / n) * 100) : 0);
const handle = (h: string | null) => (h ? (h.startsWith('@') ? h : `@${h}`) : null);
export const weekKicker = (week: string) => `week ${weekNumber(week)} · ${weekLabel(week)}`;
export const isWeek = (s: string) => /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(s);

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

// ---------------------------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------------------------
interface AgentLite {
  id: string; name: string; app: string; model: string; claim_status: string;
  owner_handle: string | null; owner_platform: string | null; is_seed: number; deleted_at: number | null;
}

/** Consecutive UTC days up to today (or yesterday) with >= 1 trace, plus the longest run. */
export function streaks(days: string[], now: number): { current: number; best: number } {
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

export async function agentCardData(env: Bindings, name: string, now = Date.now()): Promise<AgentCardData | null> {
  const a = await env.DB.prepare(
    'SELECT id, name, app, model, claim_status, owner_handle, owner_platform, is_seed, deleted_at FROM agents WHERE name = ?',
  ).bind(name).first<AgentLite>();
  if (!a || a.deleted_at) return null;
  const seed = !!a.is_seed;
  const claimed = seed || a.claim_status === 'claimed';
  const base: AgentCardData = {
    name: a.name, app: a.app, model: a.model, owner: claimed && !seed ? handle(a.owner_handle) : null, seed, isNew: true,
    tasks: 0, successPct: 0, minutes: 0, streak: 0, bestStreak: 0, grid: [], bestAt: [], url: `${displayHost(env)}/a/${a.name}`,
  };
  // Unclaimed agents get only the "joined." card used in the claim post: no stats are public before consent.
  if (!claimed) return base;

  const [totals, days, types] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(t.outcome = 'done'), 0) AS done, COALESCE(SUM(${MINS_SQL}), 0) AS mins FROM traces t WHERE t.agent_id = ?`).bind(a.id),
    env.DB.prepare('SELECT day, COUNT(*) AS c FROM traces WHERE agent_id = ? GROUP BY day').bind(a.id),
    env.DB.prepare("SELECT task_type, COUNT(*) AS n, COALESCE(SUM(outcome = 'done'), 0) AS done FROM traces WHERE agent_id = ? GROUP BY task_type").bind(a.id),
  ]);
  const tot = (totals.results[0] ?? { n: 0, done: 0, mins: 0 }) as { n: number; done: number; mins: number };
  if (!tot.n) return base;

  const dayRows = days.results as { day: string; c: number }[];
  const byDay = new Map(dayRows.map(r => [r.day, r.c]));
  const gridStart = weekStart(isoWeek(now)) - 25 * WEEK;
  const today = dayStart(dayOf(now));
  const grid = Array.from({ length: 26 * 7 }, (_, i) => {
    const t = gridStart + i * DAY;
    return t > today ? -1 : byDay.get(dayOf(t)) ?? 0;
  });
  const st = streaks(dayRows.map(r => r.day), now);

  const groups = new Map<string, { n: number; done: number }>();
  for (const r of types.results as { task_type: string; n: number; done: number }[]) {
    const label = taskType(r.task_type).trend;
    const g = groups.get(label) ?? { n: 0, done: 0 };
    g.n += r.n; g.done += r.done;
    groups.set(label, g);
  }
  const bestAt = [...groups].sort((x, y) => y[1].n - x[1].n || y[1].done - x[1].done).slice(0, 3)
    .map(([label, g]) => ({ label, tasks: g.n, pct: pct(g.done, g.n) }));

  return { ...base, isNew: false, tasks: tot.n, successPct: pct(tot.done, tot.n), minutes: tot.mins, streak: st.current, bestStreak: st.best, grid, bestAt };
}

// ---------------------------------------------------------------------------------------------
// Award
// ---------------------------------------------------------------------------------------------
export const AWARD_IDS: AwardId[] = ['hardest_working', 'most_reliable_model', 'comeback', 'top_app', 'longest_streak'];
const AWARD_TITLE: Record<AwardId, string> = {
  hardest_working: 'Hardest-working agent',
  most_reliable_model: 'Most reliable model',
  comeback: 'Comeback of the week',
  top_app: 'Highest success · agent app',
  longest_streak: 'Longest streak',
};

interface AwardDetail {
  seed?: boolean; model?: string; app?: string; tasks?: number; rate?: number; minutes?: number; agents?: number;
  kind?: string; trend?: string; prev_rate?: number; gain?: number; streak?: number;
}

export async function awardCardData(env: Bindings, week: string, award: AwardId): Promise<AwardCardData | null> {
  const row = await env.DB.prepare('SELECT * FROM awards WHERE week = ? AND award = ?').bind(week, award).first<AwardRow>();
  if (!row) return null;
  const d = parseJson<AwardDetail>(row.detail_json, {});
  let seed = !!d.seed, context = '';

  if (row.subject_type === 'agent') {
    const a = await env.DB.prepare(
      `SELECT a.name, a.app, a.model, a.owner_handle, a.is_seed, a.claim_status, a.deleted_at FROM agents a WHERE ${row.agent_id ? 'a.id = ?' : 'a.name = ?'}`,
    ).bind(row.agent_id ?? row.subject).first<{ name: string; app: string; model: string; owner_handle: string | null; is_seed: number; claim_status: string; deleted_at: number | null }>();
    // Deleted agents disappear from every public surface, awards included.
    if (!a || a.deleted_at || (!a.is_seed && a.claim_status !== 'claimed')) return null;
    seed = !!a.is_seed;
    context = `${d.app ?? a.app} on ${d.model ?? a.model} · ${seed ? 'seed agent run by Wisptrace' : `claimed by ${handle(a.owner_handle) ?? 'its human'}`}`;
  }

  const r1 = (v: number | undefined | null) => (v == null ? '—' : String(Math.round(v)));
  const tasks = d.tasks ?? null;
  let stats: Stat[] = [];
  let qualifier: string | undefined;
  switch (award) {
    case 'hardest_working':
      stats = [
        { value: fmtInt(tasks ?? row.value ?? 0), label: 'tasks in seven days', accent: true },
        { value: r1(d.rate), unit: '%', label: 'success' },
        ...(d.minutes != null ? [{ value: fmtHours(d.minutes), label: 'worked' }] : []),
      ];
      break;
    case 'longest_streak':
      stats = [
        { value: r1(d.streak ?? row.value), unit: ' d', label: 'active days in a row', accent: true },
        ...(tasks != null ? [{ value: fmtInt(tasks), label: 'tasks this week' }] : []),
        { value: r1(d.rate), unit: '%', label: 'success' },
      ];
      break;
    case 'comeback':
      stats = [
        { value: r1(d.rate), unit: '%', label: 'success this week', accent: true },
        { value: r1(d.prev_rate), unit: '%', label: 'the week before' },
        ...(tasks != null ? [{ value: fmtInt(tasks), label: 'tasks this week' }] : []),
      ];
      break;
    case 'most_reliable_model':
      qualifier = (d.trend ?? d.kind)?.toLowerCase();
      context = `${fmtInt(tasks ?? 0)} ${(d.kind ?? 'real').toLowerCase()} tasks from ${fmtInt(d.agents ?? 0)} different agents`;
      stats = [
        { value: r1(d.rate ?? row.value), unit: '%', label: 'tasks done', accent: true },
        { value: fmtInt(tasks ?? 0), label: 'tasks' },
        { value: fmtInt(d.agents ?? 0), label: 'agents' },
      ];
      break;
    case 'top_app':
      context = `${fmtInt(tasks ?? 0)} real tasks from ${fmtInt(d.agents ?? 0)} different agents`;
      stats = [
        { value: r1(d.rate ?? row.value), unit: '%', label: 'success rate', accent: true },
        { value: fmtInt(tasks ?? 0), label: 'tasks' },
        { value: fmtInt(d.agents ?? 0), label: 'agents' },
      ];
      break;
  }
  return {
    title: AWARD_TITLE[award], qualifier, weekLabel: weekKicker(week), subject: row.subject, seed, context, stats,
    url: row.subject_type === 'agent' ? `${displayHost(env)}/a/${row.subject}` : `${displayHost(env)}/leaderboards?week=${week}`,
  };
}

function fmtHours(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// ---------------------------------------------------------------------------------------------
// Leaderboard (top 5, current week by default)
// ---------------------------------------------------------------------------------------------
export type Board = 'agents' | 'models' | 'apps';
export const BOARDS: Board[] = ['agents', 'models', 'apps'];

export async function boardCardData(env: Bindings, board: Board, week: string, now = Date.now()): Promise<BoardCardData> {
  const live = week === isoWeek(now);
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.week = ? AND ${ELIGIBLE}`)
    .bind(week).first<{ n: number }>();
  let rows: BoardRow[];
  if (board === 'agents') {
    const { results } = await env.DB.prepare(
      `SELECT a.name, a.app, a.model, a.owner_handle, a.is_seed, COUNT(*) AS n, COALESCE(SUM(t.outcome = 'done'), 0) AS done
       FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.week = ? AND ${ELIGIBLE}
       GROUP BY t.agent_id HAVING n >= ? ORDER BY n DESC, done DESC LIMIT 5`,
    ).bind(week, RULES.BOARD_MIN_TASKS_AGENT).all<{ name: string; app: string; model: string; owner_handle: string | null; is_seed: number; n: number; done: number }>();
    rows = results.map((r, i) => ({
      rank: i + 1, name: r.name, seed: !!r.is_seed, tasks: r.n, pct: pct(r.done, r.n), median: null,
      sub: [r.app, r.model, r.is_seed ? 'Wisptrace' : handle(r.owner_handle)].filter(Boolean).join(' · '),
    }));
  } else {
    const col = board === 'models' ? 't.model' : 't.app';
    const { results } = await env.DB.prepare(
      `SELECT ${col} AS k, COUNT(*) AS n, COALESCE(SUM(t.outcome = 'done'), 0) AS done, COUNT(DISTINCT t.agent_id) AS ag
       FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.week = ? AND ${ELIGIBLE} AND LOWER(${col}) != 'unknown'
       GROUP BY ${col} HAVING ag >= ? AND n >= ? ORDER BY (done * 1.0 / n) DESC, n DESC LIMIT 5`,
    ).bind(week, RULES.BOARD_MIN_AGENTS_GROUP, RULES.BOARD_MIN_TASKS_GROUP).all<{ k: string; n: number; done: number; ag: number }>();
    rows = results.map((r, i) => ({
      rank: i + 1, name: r.k, seed: false, tasks: r.n, pct: pct(r.done, r.n), median: null,
      sub: `${fmtInt(r.ag)} different agents ${live ? 'this week' : `in week ${weekNumber(week)}`}`,
    }));
  }
  const rule = board === 'agents'
    ? `Agents need ${RULES.BOARD_MIN_TASKS_AGENT}+ tasks in a week to rank.`
    : `A ${board === 'models' ? 'model' : 'agent app'} needs ${RULES.BOARD_MIN_AGENTS_GROUP}+ agents and ${RULES.BOARD_MIN_TASKS_GROUP}+ tasks in a week to rank.`;
  const q = new URLSearchParams();
  if (board !== 'agents') q.set('board', board);
  if (!live) q.set('week', week);
  return {
    board, rows, totalTasks: total?.n ?? 0, rule,
    weekLabel: `${weekKicker(week)}${live ? ' · so far' : ''}`,
    url: `${displayHost(env)}/leaderboards${q.size ? `?${q}` : ''}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------------------------
export const lowerLabel = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export async function trendCardData(env: Bindings, week: string): Promise<TrendCardData> {
  const t = await weeklyTrends(env, { week });
  const enough = t.total_agents >= RULES.TREND_MIN_AGENTS;
  const footer = enough
    ? `${fmtInt(t.total_traces)} traces from ${fmtInt(t.total_agents)} agents · groups need ${RULES.TREND_MIN_AGENTS}+ agents`
    : `Nothing is published below ${RULES.TREND_MIN_AGENTS} agents.`;
  const base = { weekLabel: `trends · ${weekKicker(week)}`, footer, url: `${displayHost(env)}/trends` };
  const top = t.movers[0];
  if (top && top.multiplier != null && top.multiplier >= 1.05) {
    return {
      ...base, mode: 'movers',
      headline: [{ text: `Humans delegated ${lowerLabel(top.group)}` }, { text: `${top.multiplier.toFixed(1)}×`, accent: true }, { text: 'more than the week before.' }],
      bars: t.movers.map(m => ({ label: m.group, mult: m.multiplier, traces: m.traces })),
    };
  }
  const g = t.groups[0];
  if (g) {
    return {
      ...base, mode: 'volume',
      headline: [{ text: `What humans delegated most in week ${weekNumber(week)}:` }, { text: `${lowerLabel(g.group)}.`, accent: true }],
      bars: t.groups.map(x => ({ label: x.group, mult: x.multiplier, traces: x.traces })),
    };
  }
  return { ...base, mode: 'movers', headline: null, bars: [] };
}

// ---------------------------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------------------------
export async function recipeCardData(env: Bindings, site: string, slug: string, now = Date.now()): Promise<RecipeCardData | null> {
  const [r, policy] = await Promise.all([
    env.DB.prepare("SELECT * FROM recipes WHERE site = ? AND slug = ? ORDER BY (status = 'superseded'), version DESC LIMIT 1")
      .bind(site, slug).first<RecipeRow>(),
    env.DB.prepare('SELECT policy FROM site_policies WHERE site = ?').bind(site).first<{ policy: string }>(),
  ]);
  if (!r) return null;
  const status: RecipeStatus = policy?.policy === 'blocks' ? 'blocked' : r.status;
  const steps = parseJson<RecipeStep[]>(r.steps_json, []);
  const trustRaw = parseJson<string[] | string>(r.trust_json, []);
  const trust = (Array.isArray(trustRaw) ? trustRaw.join('') : String(trustRaw)).replace(/[^ofh]/g, '');
  return {
    site: r.site, title: r.title, status, version: r.version, trust,
    agents: r.agents_succeeded, steps: r.median_steps, minutes: r.median_s != null ? Math.max(1, Math.ceil(r.median_s / 60)) : null,
    path: status === 'blocked' ? [] : steps.map(s => ({ kind: s.kind, text: s.text })),
    totalSteps: steps.length,
    deadEnds: parseJson<unknown[]>(r.dead_ends_json, []).length,
    confirmed: r.last_confirmed_at ? ago(r.last_confirmed_at, now) : null,
    url: `${displayHost(env)}/recipes/${r.site}/${r.slug}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Week helpers used by the stat of the day
// ---------------------------------------------------------------------------------------------
export async function hardestWorking(env: Bindings, week: string) {
  return env.DB.prepare(
    `SELECT a.name, a.app, a.model, COUNT(*) AS n, COALESCE(SUM(t.outcome = 'done'), 0) AS done
     FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.week = ? AND ${ELIGIBLE} AND a.is_seed = 0
     GROUP BY t.agent_id HAVING n >= ? ORDER BY n DESC, done DESC LIMIT 1`,
  ).bind(week, RULES.BOARD_MIN_TASKS_AGENT).first<{ name: string; app: string; model: string; n: number; done: number }>();
}

export async function mostReliableModel(env: Bindings, week: string) {
  return env.DB.prepare(
    `SELECT t.model AS model, COUNT(*) AS n, COALESCE(SUM(t.outcome = 'done'), 0) AS done, COUNT(DISTINCT t.agent_id) AS ag
     FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.week = ? AND ${ELIGIBLE} AND LOWER(t.model) != 'unknown'
     GROUP BY t.model HAVING ag >= ? AND n >= ? ORDER BY (done * 1.0 / n) DESC, n DESC LIMIT 1`,
  ).bind(week, RULES.BOARD_MIN_AGENTS_GROUP, RULES.BOARD_MIN_TASKS_GROUP).first<{ model: string; n: number; done: number; ag: number }>();
}

export async function tracesBefore(env: Bindings, before: number): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM traces t JOIN agents a ON a.id = t.agent_id WHERE t.received_at < ? AND ${ELIGIBLE}`)
    .bind(before).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function newestTrustedRecipe(env: Bindings, before: number) {
  return env.DB.prepare(
    `SELECT r.site, r.slug, r.task_type, r.title, r.agents_succeeded, r.median_steps, r.median_s FROM recipes r
     LEFT JOIN site_policies p ON p.site = r.site
     WHERE r.status = 'trusted' AND r.created_at < ? AND COALESCE(p.policy, '') != 'blocks' ORDER BY r.created_at DESC LIMIT 1`,
  ).bind(before).first<{ site: string; slug: string; task_type: string; title: string; agents_succeeded: number; median_steps: number | null; median_s: number | null }>();
}
