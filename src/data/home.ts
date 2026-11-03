// Home page aggregates (UI-1): mini model board, trend sparkline, recipe preview. Cached 60 s.
import type { Bindings } from '../env';
import type { DeadEnd, RecipeStep } from '../types';
import { RULES } from '../lib/rules';
import { TASK_TYPES, taskType, typesInTrend } from '../lib/taxonomy';
import { DAY, dayOf, isoWeek, lastCompleteWeek, MIN } from '../lib/time';
import { publicDeadEnds, publicSteps } from '../processing/recipes';
import { cached } from '../processing/snapshots';
import { weeklyTrends } from '../processing/trends';
import { ELIGIBLE } from './live';

export interface ModelBoardRow { rank: number; model: string; tasks: number; rate: number }
export interface ModelBoard {
  caption: string;        // 'which model books a table best'
  week: string;
  rows: ModelBoardRow[];  // up to 4, best success rate first; [] when nothing qualifies
}

/** 'Book a table' -> 'books a table' (third person for the board caption). */
export function thirdPerson(imperative: string): string {
  const [verb = '', ...rest] = imperative.trim().split(/\s+/);
  const v = verb.toLowerCase();
  const s = /(s|x|z|ch|sh)$/.test(v) ? `${v}es` : /[^aeiou]y$/.test(v) ? `${v.slice(0, -1)}ies` : `${v}s`;
  return [s, ...rest].join(' ');
}

async function topTaskType(env: Bindings, week: string): Promise<{ task_type: string; n: number } | null> {
  const r = await env.DB.prepare(
    `SELECT t.task_type, COUNT(*) AS n FROM traces t JOIN agents a ON a.id = t.agent_id
     WHERE t.week = ? AND ${ELIGIBLE} AND t.task_type != 'other' GROUP BY t.task_type ORDER BY n DESC LIMIT 1`,
  ).bind(week).first<{ task_type: string; n: number }>();
  return r ?? null;
}

async function computeModelBoard(env: Bindings, now: number): Promise<ModelBoard> {
  // The current week once it has enough traces of its top kind; before that, the last complete week.
  for (const week of [isoWeek(now), lastCompleteWeek(now)]) {
    const top = await topTaskType(env, week);
    if (!top || top.n < RULES.BOARD_MIN_TASKS_GROUP) continue;
    const { results } = await env.DB.prepare(
      `SELECT t.model, COUNT(*) AS n, COALESCE(SUM(t.outcome = 'done'), 0) AS done, COUNT(DISTINCT t.agent_id) AS ag
       FROM traces t JOIN agents a ON a.id = t.agent_id
       WHERE t.week = ? AND t.task_type = ? AND ${ELIGIBLE} AND LOWER(t.model) != 'unknown'
       GROUP BY t.model HAVING ag >= ? ORDER BY (done * 1.0 / n) DESC, n DESC LIMIT 4`,
    ).bind(week, top.task_type, RULES.BOARD_MIN_AGENTS_GROUP).all<{ model: string; n: number; done: number; ag: number }>();
    if (results.length < 2) continue;
    return {
      caption: `which model ${thirdPerson(taskType(top.task_type).recipe)} best`,
      week,
      rows: results.map((r, i) => ({ rank: i + 1, model: r.model, tasks: r.n, rate: Math.round((r.done / r.n) * 100) })),
    };
  }
  return { caption: 'which model gets it done', week: isoWeek(now), rows: [] };
}

export const modelBoard = (env: Bindings, now = Date.now()) => cached(env, 'home:model-board', MIN, () => computeModelBoard(env, now));

export interface Spark {
  group: string;                           // trend group label, e.g. 'Gift shopping'
  days: { day: string; traces: number | null }[]; // 14 days ending yesterday; null = below the k-anonymity threshold
  multiplier: number | null;               // last complete week vs the week before (null when not publishable)
  published: boolean;                      // enough published days to draw
}

async function computeSpark(env: Bindings, now: number): Promise<Spark> {
  const trends = await weeklyTrends(env, { now }).catch(() => null);
  const pick = trends?.movers[0] ?? trends?.groups[0] ?? null;
  const group = pick?.group ?? 'Online shopping';
  const types = typesInTrend(group).filter(id => TASK_TYPES.some(t => t.id === id));
  const yesterday = now - DAY;
  const from = dayOf(yesterday - 13 * DAY);
  const to = dayOf(yesterday);
  const marks = types.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT t.day, COUNT(*) AS traces, COUNT(DISTINCT t.agent_id) AS agents FROM traces t JOIN agents a ON a.id = t.agent_id
     WHERE t.day >= ? AND t.day <= ? AND ${ELIGIBLE} AND t.task_type IN (${marks}) GROUP BY t.day`,
  ).bind(from, to, ...types).all<{ day: string; traces: number; agents: number }>();
  const byDay = new Map(results.map(r => [r.day, r]));
  const days: Spark['days'] = [];
  for (let i = 13; i >= 0; i--) {
    const day = dayOf(yesterday - i * DAY);
    const r = byDay.get(day);
    days.push({ day, traces: r && r.agents >= RULES.TREND_MIN_AGENTS ? r.traces : null });
  }
  const published = days.filter(d => d.traces != null).length >= 10;
  return { group, days, multiplier: pick?.multiplier ?? null, published };
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
     LEFT JOIN site_policies p ON p.site = r.site
     WHERE r.status = 'trusted' AND COALESCE(p.policy, '') != 'blocks' ORDER BY r.agents_succeeded DESC, r.updated_at DESC LIMIT 1`,
  ).first<{ site: string; slug: string; title: string; version: number; agents_succeeded: number; steps_json: string; dead_ends_json: string }>();
  if (!r) return null;
  const steps = publicSteps(r.steps_json);
  const deadEnds = publicDeadEnds(r.dead_ends_json).sort((a, b) => b.agents - a.agents);
  return { site: r.site, slug: r.slug, title: r.title, version: r.version, agents: r.agents_succeeded, steps: steps.slice(0, 4), deadEnd: deadEnds[0] ?? null };
}

export const recipePreview = (env: Bindings) => cached(env, 'home:recipe-preview', MIN, () => computeRecipePreview(env));
