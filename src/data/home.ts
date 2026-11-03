// Home page aggregates (UI-1): mini model board, trend sparkline, recipe preview. Cached 60 s.
import type { Bindings } from '../env';
import type { DeadEnd, RecipeStep } from '../types';
import { RULES } from '../lib/rules';
import { thirdPerson } from '../lib/tasks';
import { DAY, dayOf, isoWeek, lastCompleteWeek, MIN } from '../lib/time';
import { publicDeadEnds, publicSteps } from '../processing/recipes';
import { cached } from '../processing/snapshots';
import { weeklyTrends } from '../processing/trends';
import { ELIGIBLE } from './live';

export interface ModelBoardRow { rank: number; model: string; tasks: number; rate: number }
export interface ModelBoard {
  caption: string;        // 'which model cancels Netflix subscription best'
  week: string;
  rows: ModelBoardRow[];  // up to 4, best success rate first; [] when nothing qualifies
}

export { thirdPerson };

/** The week's most delegated task whose name is public (and not sensitive). */
async function topTask(env: Bindings, week: string): Promise<{ task_id: string; label: string; n: number } | null> {
  const r = await env.DB.prepare(
    `SELECT t.task_id, k.label, COUNT(*) AS n FROM traces t JOIN agents a ON a.id = t.agent_id JOIN tasks k ON k.id = t.task_id
     WHERE t.week = ? AND ${ELIGIBLE} AND k.crowd >= ? AND k.sensitive = 0 AND k.verb != '' GROUP BY t.task_id ORDER BY n DESC LIMIT 1`,
  ).bind(week, RULES.TASK_PUBLIC_MIN_CROWD).first<{ task_id: string; label: string; n: number }>();
  return r ?? null;
}

async function computeModelBoard(env: Bindings, now: number): Promise<ModelBoard> {
  // The current week once it has enough traces of its top kind; before that, the last complete week.
  for (const week of [isoWeek(now), lastCompleteWeek(now)]) {
    const top = await topTask(env, week);
    if (!top || top.n < RULES.BOARD_MIN_TASKS_GROUP) continue;
    const { results } = await env.DB.prepare(
      `SELECT t.model, COUNT(*) AS n, COALESCE(SUM(t.outcome = 'done'), 0) AS done, COUNT(DISTINCT t.agent_id) AS ag
       FROM traces t JOIN agents a ON a.id = t.agent_id
       WHERE t.week = ? AND t.task_id = ? AND ${ELIGIBLE} AND LOWER(t.model) != 'unknown'
       GROUP BY t.model HAVING ag >= ? AND n >= ? ORDER BY (done * 1.0 / n) DESC, n DESC LIMIT 4`,
    ).bind(week, top.task_id, RULES.BOARD_MIN_AGENTS_GROUP, RULES.BOARD_MIN_TASKS_GROUP).all<{ model: string; n: number; done: number; ag: number }>();
    if (results.length < 2) continue;
    return {
      caption: `which model ${thirdPerson(top.label)} best`,
      week,
      rows: results.map((r, i) => ({ rank: i + 1, model: r.model, tasks: r.n, rate: Math.round((r.done / r.n) * 100) })),
    };
  }
  return { caption: 'which model gets it done', week: isoWeek(now), rows: [] };
}

export const modelBoard = (env: Bindings, now = Date.now()) => cached(env, 'home:model-board', MIN, () => computeModelBoard(env, now));

export interface Spark {
  label: string;                           // caption subject: a public task name, or 'all'
  days: { day: string; traces: number | null }[]; // 14 days ending yesterday; null = below the k-anonymity threshold
  multiplier: number | null;               // week-over-week (null when not publishable)
  published: boolean;                      // enough published days to draw
}

const enoughDays = (days: Spark['days']) => days.filter(d => d.traces != null).length >= 10;

async function taskDays(env: Bindings, taskId: string, now: number): Promise<Spark['days']> {
  const yesterday = now - DAY;
  const { results } = await env.DB.prepare(
    `SELECT t.day, COUNT(*) AS traces, COUNT(DISTINCT t.agent_id) AS agents FROM traces t JOIN agents a ON a.id = t.agent_id
     WHERE t.day >= ? AND t.day <= ? AND ${ELIGIBLE} AND t.task_id = ? GROUP BY t.day`,
  ).bind(dayOf(yesterday - 13 * DAY), dayOf(yesterday), taskId).all<{ day: string; traces: number; agents: number }>();
  const byDay = new Map(results.map(r => [r.day, r]));
  const days: Spark['days'] = [];
  for (let i = 13; i >= 0; i--) {
    const day = dayOf(yesterday - i * DAY);
    const r = byDay.get(day);
    days.push({ day, traces: r && r.agents >= RULES.TREND_MIN_AGENTS ? r.traces : null });
  }
  return days;
}

/** Last 7 days vs the 7 before, only when every one of the 14 days is published. */
function wow(days: Spark['days']): number | null {
  if (days.length !== 14 || days.some(d => d.traces == null)) return null;
  const sum = (a: Spark['days']) => a.reduce((n, d) => n + (d.traces ?? 0), 0);
  const prev = sum(days.slice(0, 7));
  return prev > 0 ? Math.round((sum(days.slice(7)) / prev) * 100) / 100 : null;
}

// The top mover if its days are publishable, then the biggest tasks, then all tasks (weeklyTrends().daily).
async function computeSpark(env: Bindings, now: number): Promise<Spark> {
  const trends = await weeklyTrends(env, { now }).catch(() => null);
  const candidates = [...(trends?.movers ?? []).slice(0, 1), ...(trends?.tasks ?? []).slice(0, 3)];
  const seen = new Set<string>();
  for (const t of candidates) {
    if (seen.has(t.task_id)) continue;
    seen.add(t.task_id);
    const days = await taskDays(env, t.task_id, now);
    if (enoughDays(days)) return { label: t.label, days, multiplier: t.multiplier ?? wow(days), published: true };
  }
  const days: Spark['days'] = (trends?.daily ?? []).slice(-14).map(d => ({ day: d.day, traces: d.published ? d.traces : null }));
  return { label: 'all', days, multiplier: wow(days), published: days.length === 14 && enoughDays(days) };
}

export const spark = (env: Bindings, now = Date.now()) => cached(env, 'home:spark', MIN, () => computeSpark(env, now));

export interface RecipePreview {
  site: string;
  slug: string;
  title: string;
  version: number;
  agents: number;
  steps: RecipeStep[];   // first 4
  deadEnd: DeadEnd | null;
}

async function computeRecipePreview(env: Bindings): Promise<RecipePreview | null> {
  const r = await env.DB.prepare(
    `SELECT r.site, r.slug, r.title, r.version, r.agents_succeeded, r.steps_json, r.dead_ends_json FROM recipes r
     JOIN tasks k ON k.id = r.task_id LEFT JOIN site_policies p ON p.site = r.site
     WHERE r.status = 'trusted' AND k.crowd >= ? AND COALESCE(p.policy, '') != 'blocks' ORDER BY r.agents_succeeded DESC, r.updated_at DESC LIMIT 1`,
  ).bind(RULES.TASK_PUBLIC_MIN_CROWD).first<{ site: string; slug: string; title: string; version: number; agents_succeeded: number; steps_json: string; dead_ends_json: string }>();
  if (!r) return null;
  const steps = publicSteps(r.steps_json);
  const deadEnds = publicDeadEnds(r.dead_ends_json).sort((a, b) => b.agents - a.agents);
  return { site: r.site, slug: r.slug, title: r.title, version: r.version, agents: r.agents_succeeded, steps: steps.slice(0, 4), deadEnd: deadEnds[0] ?? null };
}

export const recipePreview = (env: Bindings) => cached(env, 'home:recipe-preview', MIN, () => computeRecipePreview(env));
