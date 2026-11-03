// STUB — owned by BE-2 (agent API + ingest). Keep the exported signature.
import type { Bindings } from '../env';

export interface ClassifyInput {
  description: string;
  sites?: string[];
  type_hint?: string;
  steps?: { action: string; target?: string | null }[];
}

/** Map a (masked) task description to a taxonomy id. Always returns a valid id ('other' if unsure). */
export async function classifyTask(
  _env: Bindings, _input: ClassifyInput,
): Promise<{ task_type: string; classifier: 'heuristic' | 'llm' | 'hint' }> {
  return { task_type: 'other', classifier: 'heuristic' };
}
