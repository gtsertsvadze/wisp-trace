// STUB — owned by BE-2 (agent API + ingest). Keep the exported signatures.
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, Bindings } from '../env';
import type { AgentRow } from '../types';

/** Requires `Authorization: Bearer wt_…`; sets c.var.agent. 401 on missing/invalid/deleted. */
export const requireAgent: MiddlewareHandler<AppEnv> = async c => c.json({ ok: false, error: 'unauthorized' }, 401);

/** Like requireAgent but continues without an agent when no/invalid key (c.var.agent may be undefined). */
export const optionalAgent: MiddlewareHandler<AppEnv> = async (_c, next) => {
  await next();
};

/** Requires `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare). 401 otherwise. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async c => c.json({ ok: false, error: 'unauthorized' }, 401);

/** Resolve an owner token (`wto_…`) to its non-deleted agent, or null. */
export async function agentByOwnerToken(_env: Bindings, _token: string): Promise<AgentRow | null> {
  return null;
}

/** Salted hash of the client IP (for rate limits). Never store raw IPs. */
export async function clientIpHash(_c: Context<AppEnv>): Promise<string> {
  return 'unknown';
}
