// STUB — owned by the processing agent (BE-3), who implements it. Keep the signature.
// Optional LLM helper (Anthropic Messages API via fetch). Returns null when ANTHROPIC_API_KEY is unset,
// on any error, or when output fails validation — callers must always have a heuristic fallback.

import type { Bindings } from '../env';

export interface LlmJsonRequest {
  model?: 'fast' | 'smart';                 // fast = classification, smart = recipe synthesis
  system: string;
  user: string;
  schema: Record<string, unknown>;          // JSON Schema the output must satisfy
  maxTokens?: number;
}

export async function llmJson<T>(_env: Bindings, _req: LlmJsonRequest): Promise<T | null> {
  return null;
}
