// Scheduled jobs. Also callable directly (POST /api/admin/run-jobs).
import type { Bindings } from '../env';
import { MIN, lastCompleteWeek } from '../lib/time';
import { computeAwards } from './awards';
import { rebuildDirtyGroups } from './recipes';
import { dropSnapshots, putSnapshot } from './snapshots';
import { rebuildDailyStats, weeklyTrends } from './trends';

export type JobName = 'recipes' | 'trends' | 'awards' | 'snapshots';

const STALE_MS = 15 * MIN;

/** Run jobs immediately (used by the cron handler and POST /api/admin/run-jobs). Never throws; errors are reported per job. */
export async function runJobs(
  env: Bindings,
  jobs: JobName[] = ['recipes', 'trends', 'awards', 'snapshots'],
  opts: { now?: number; week?: string } = {},
): Promise<Record<string, unknown>> {
  const now = opts.now ?? Date.now();
  const out: Record<string, unknown> = {};
  for (const job of jobs) {
    const t0 = Date.now();
    try {
      let result: unknown;
      switch (job) {
        case 'recipes':
          result = await rebuildDirtyGroups(env, { now });
          break;
        case 'trends': {
          const rows = await rebuildDailyStats(env, { now });
          const weeks = [...new Set([lastCompleteWeek(now), ...(opts.week ? [opts.week] : [])])];
          const warmed: Record<string, number> = {};
          for (const week of weeks) {
            await dropSnapshots(env, `trends:${week}`);
            warmed[week] = (await weeklyTrends(env, { week, now })).groups.length;
          }
          result = { daily_rows: rows, groups: warmed };
          break;
        }
        case 'awards': {
          const weeks = [...new Set([lastCompleteWeek(now), ...(opts.week ? [opts.week] : [])])];
          const written: Record<string, number> = {};
          for (const week of weeks) written[week] = await computeAwards(env, week, now);
          await dropSnapshots(env, 'board:');
          result = { awards: written };
          break;
        }
        case 'snapshots': {
          const r = await env.DB.prepare("DELETE FROM snapshots WHERE (key LIKE 'trends:%' OR key LIKE 'board:%') AND computed_at < ?")
            .bind(Date.now() - STALE_MS).run();
          result = { dropped: r.meta.changes ?? 0 };
          break;
        }
        default:
          result = { error: 'unknown_job' };
      }
      out[job] = { ok: true, ms: Date.now() - t0, result };
    } catch (e) {
      console.error('cron: job failed', job, e instanceof Error ? e.message : String(e));
      out[job] = { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
    }
  }
  await putSnapshot(env, 'jobs:last', { at: now, jobs: out }).catch(() => undefined);
  return out;
}

const SCHEDULE: Record<string, JobName[]> = {
  '*/5 * * * *': ['recipes', 'snapshots'],
  '0 * * * *': ['trends'],
  '0 6 * * 1': ['awards'],
};

export async function scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
  const jobs = SCHEDULE[controller.cron] ?? ['recipes', 'snapshots'];
  ctx.waitUntil(runJobs(env, jobs, { now: controller.scheduledTime || Date.now() }).then(r => {
    console.log('cron', controller.cron, JSON.stringify(r));
  }));
}
