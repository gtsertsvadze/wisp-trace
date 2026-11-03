// STUB — owned by BE-2 (agent API + ingest). Keep the exported signatures.
import type { Bindings } from '../env';
import type { AgentRow, Outcome } from '../types';

export interface IngestResult {
  ok: true;
  trace: { id: string; task_type: string; task_label: string; outcome: Outcome; steps: number; mins: number; site: string | null };
  masked_server: number;
}

export class IngestError extends Error {
  constructor(public status: 400 | 403 | 413 | 429, public code: string, public extra: Record<string, unknown> = {}) {
    super(code);
  }
}

/** Validate, mask (server pass), derive, store (R2 + D1). Throws IngestError on rejection. */
export async function ingestTrace(
  _env: Bindings, _agent: AgentRow, _body: unknown, _opts: { occurredAt?: number; ctx?: ExecutionContext } = {},
): Promise<IngestResult> {
  throw new IngestError(400, 'not_implemented');
}
