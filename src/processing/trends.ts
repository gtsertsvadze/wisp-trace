// STUB — owned by BE-3 (processing). Keep the exported signatures.
import type { Bindings } from '../env';
import type { WeeklyTrends } from '../types';
import { lastCompleteWeek, shiftWeek } from '../lib/time';

/** Rebuild daily_task_stats from traces for the last `days` days. */
export async function rebuildDailyStats(_env: Bindings, _opts: { now?: number; days?: number } = {}): Promise<number> {
  return 0;
}

/** Weekly trends for `week` (default: last complete week), k-anonymity applied. Cached in snapshots. */
export async function weeklyTrends(_env: Bindings, opts: { week?: string; now?: number } = {}): Promise<WeeklyTrends> {
  const now = opts.now ?? Date.now();
  const week = opts.week ?? lastCompleteWeek(now);
  return { week, prev_week: shiftWeek(week, -1), groups: [], movers: [], daily: [], total_traces: 0, total_agents: 0, computed_at: now };
}
