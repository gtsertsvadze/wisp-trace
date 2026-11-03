// Trends page data: the weekly view model built on weeklyTrends() plus the Black Friday shopping baseline.
// Every number here is k-anonymous: nothing is published from fewer than RULES.TREND_MIN_AGENTS distinct agents.
// Distinct agents can't be summed across days or task types, so the weekly figures come from `traces` directly
// (daily_task_stats only holds per-(day, type) agent counts and covers the last ~16 days).
import type { Bindings } from '../env';
import type { TrendGroupWeek, WeeklyTrends } from '../types';
import { RULES } from '../lib/rules';
import { TASK_TYPES } from '../lib/taxonomy';
import { DAY, dayOf, dayStart, lastCompleteWeek, MIN, shiftWeek, weekStart } from '../lib/time';
import { weeklyTrends } from '../processing/trends';
import { cached } from '../processing/snapshots';

const ELIGIBLE = "a.deleted_at IS NULL AND (a.claim_status = 'claimed' OR a.is_seed = 1)";
const K = RULES.TREND_MIN_AGENTS;

export const isWeekId = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(s);

export interface MoverRow {
  group: string;
  multiplier: number;      // this week / last week
  traces: number;
  prev_traces: number;
  width_pct: number;       // bar fill, relative to the largest value on the panel
  tick_pct: number;        // last week's value on the same scale
}

export interface TopRow {
  rank: number;
  group: string;
  traces: number;
  delta_pct: number | null; // vs last week, null when last week isn't published
}

export interface DayColumn {
  day: string;
  label: string;           // day of month, '26'
  traces: number;
  height_pct: number;      // 0-100 of the tallest published day
  weekend: boolean;
  last: boolean;
  published: boolean;
}

export interface ShoppingWatch {
  multiplier: number | null; // this week's shopping volume vs the October 2026 weekly baseline
  week_traces: number;
  baseline_weekly: number;
}

export interface TrendsPageData {
  week: string;
  prev_week: string;
  latest_week: string;     // last complete week; ?week= can't go past it
  trends: WeeklyTrends;
  top_mover: TrendGroupWeek | null;
  movers: MoverRow[];      // up to 8, biggest change either way, shown by multiplier desc
  top: TopRow[];           // up to 6 most delegated groups
  days: DayColumn[];       // 14 columns ending yesterday
  shopping: ShoppingWatch;
}

const SHOPPING_TYPES = TASK_TYPES.filter(t => t.kind === 'Shopping').map(t => t.id);
// Black Friday 2026 watch: October 2026 is the baseline month, measured as a weekly rate.
const OCT_FROM = Date.UTC(2026, 9, 1);
const OCT_TO = Date.UTC(2026, 10, 1); // exclusive

async function shoppingWatch(env: Bindings, week: string): Promise<ShoppingWatch> {
  const none: ShoppingWatch = { multiplier: null, week_traces: 0, baseline_weekly: 0 };
  const baselineEnd = Math.min(OCT_TO, weekStart(week)); // never let the report week count toward its own baseline
  const baselineDays = Math.round((baselineEnd - OCT_FROM) / DAY);
  if (baselineDays < 7) return none;
  const placeholders = SHOPPING_TYPES.map(() => '?').join(',');
  const [wk, base] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT t.agent_id) AS agents FROM traces t JOIN agents a ON a.id = t.agent_id
       WHERE t.week = ? AND t.task_type IN (${placeholders}) AND ${ELIGIBLE}`,
    ).bind(week, ...SHOPPING_TYPES).first<{ n: number; agents: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT t.agent_id) AS agents FROM traces t JOIN agents a ON a.id = t.agent_id
       WHERE t.day >= ? AND t.day < ? AND t.task_type IN (${placeholders}) AND ${ELIGIBLE}`,
    ).bind(dayOf(OCT_FROM), dayOf(baselineEnd), ...SHOPPING_TYPES).first<{ n: number; agents: number }>(),
  ]);
  if (!wk || !base || wk.agents < K || base.agents < K || base.n === 0) return none;
  const baselineWeekly = (base.n / baselineDays) * 7;
  return { multiplier: Math.round((wk.n / baselineWeekly) * 10) / 10, week_traces: wk.n, baseline_weekly: Math.round(baselineWeekly) };
}

function pickMovers(all: TrendGroupWeek[]): MoverRow[] {
  const withMult = all.filter((g): g is TrendGroupWeek & { multiplier: number } => g.multiplier !== null && g.multiplier > 0);
  // "Biggest movers" means the largest change in either direction, so rank by |log(multiplier)|.
  const chosen = [...withMult].sort((a, b) => Math.abs(Math.log(b.multiplier)) - Math.abs(Math.log(a.multiplier)) || b.traces - a.traces).slice(0, 8);
  chosen.sort((a, b) => b.multiplier - a.multiplier || b.traces - a.traces);
  const max = Math.max(1, ...chosen.map(g => Math.max(g.traces, g.prev_traces)));
  return chosen.map(g => ({
    group: g.group,
    multiplier: g.multiplier,
    traces: g.traces,
    prev_traces: g.prev_traces,
    width_pct: Math.min(100, (g.traces / max) * 100),
    tick_pct: Math.min(100, (g.prev_traces / max) * 100),
  }));
}

function topGroups(groups: TrendGroupWeek[]): TopRow[] {
  return groups.slice(0, 6).map((g, i) => ({
    rank: i + 1,
    group: g.group,
    traces: g.traces,
    delta_pct: g.multiplier === null ? null : Math.round((g.multiplier - 1) * 100),
  }));
}

function dayColumns(daily: WeeklyTrends['daily']): DayColumn[] {
  const max = Math.max(1, ...daily.filter(d => d.published).map(d => d.traces));
  return daily.map((d, i) => {
    const dow = new Date(dayStart(d.day)).getUTCDay();
    return {
      day: d.day,
      label: String(Number(d.day.slice(8))),
      traces: d.traces,
      height_pct: d.published ? Math.max(2, (d.traces / max) * 100) : 0,
      weekend: dow === 0 || dow === 6,
      last: i === daily.length - 1,
      published: d.published,
    };
  });
}

/** Everything the /trends page renders for `week` (default: last complete week). Cached 60 s on top of weeklyTrends' own cache. */
export async function trendsPageData(env: Bindings, opts: { week?: string; now?: number } = {}): Promise<TrendsPageData> {
  const now = opts.now ?? Date.now();
  const latest = lastCompleteWeek(now);
  const week = opts.week && isWeekId(opts.week) && opts.week <= latest ? opts.week : latest;
  return cached(env, `trends-page:${week}`, MIN, async () => {
    const [trends, shopping] = await Promise.all([weeklyTrends(env, { week, now }), shoppingWatch(env, week)]);
    return {
      week,
      prev_week: shiftWeek(week, -1),
      latest_week: latest,
      trends,
      top_mover: trends.movers[0] ?? null,
      movers: pickMovers(trends.movers),
      top: topGroups(trends.groups),
      days: dayColumns(trends.daily),
      shopping,
    };
  });
}
