// STUB — owned by BE-3 (processing). Keep these exported signatures.
import type { Bindings } from '../env';

export type JobName = 'recipes' | 'trends' | 'awards' | 'snapshots';

/** Run jobs immediately (used by the cron handler and POST /api/admin/run-jobs). */
export async function runJobs(
  _env: Bindings,
  _jobs: JobName[] = ['recipes', 'trends', 'awards', 'snapshots'],
  _opts: { now?: number; week?: string } = {},
): Promise<Record<string, unknown>> {
  return {};
}

export async function scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(runJobs(env));
  void controller;
}
