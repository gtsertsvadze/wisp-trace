// Auth for the agent API (api keys), the owner view (owner tokens) and admin (ADMIN_TOKEN).
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, Bindings } from '../env';
import type { AgentRow } from '../types';
import { AGENT_TEXT } from './agent-text';
import { sha256Hex } from './ids';
import { execCtx, jsonError } from './http';

const LAST_SEEN_EVERY_MS = 60_000;

function bearer(c: Context): string | null {
  const h = c.req.header('authorization');
  const m = h && /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

/** Look up the agent for an api key (deleted agents included, so callers can tell them apart). */
async function agentByApiKey(env: Bindings, key: string): Promise<AgentRow | null> {
  if (!/^wt_[A-Za-z0-9]{20,80}$/.test(key)) return null;
  return env.DB.prepare('SELECT * FROM agents WHERE api_key_hash = ?').bind(await sha256Hex(key)).first<AgentRow>();
}

/** Bump last_seen_at at most once a minute; never blocks or fails the request. */
function touch(c: Context<AppEnv>, agent: AgentRow): void {
  const now = Date.now();
  if (agent.last_seen_at && now - agent.last_seen_at < LAST_SEEN_EVERY_MS) return;
  agent.last_seen_at = now;
  const p = c.env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').bind(now, agent.id).run().catch(() => {});
  const ctx = execCtx(c);
  if (ctx) ctx.waitUntil(p);
}

/** Requires `Authorization: Bearer wt_…`; sets c.var.agent. 401 on missing/invalid/deleted. */
export const requireAgent: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = bearer(c);
  if (!key) return jsonError(c, 401, 'unauthorized', 'Missing Authorization: Bearer <api_key>.');
  const agent = await agentByApiKey(c.env, key);
  if (!agent) return jsonError(c, 401, 'unauthorized', 'Unknown API key.');
  if (agent.deleted_at) return jsonError(c, 401, 'agent_deleted', AGENT_TEXT.notices.deleted);
  touch(c, agent);
  c.set('agent', agent);
  await next();
};

/** Like requireAgent but continues without an agent when no/invalid key (c.var.agent may be undefined). */
export const optionalAgent: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = bearer(c);
  if (key) {
    const agent = await agentByApiKey(c.env, key).catch(() => null);
    if (agent && !agent.deleted_at) {
      touch(c, agent);
      c.set('agent', agent);
    }
  }
  await next();
};

/** Constant-time string equality (compares fixed-length digests, so length doesn't leak either). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Requires `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare). 401 otherwise. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  const got = bearer(c);
  if (!expected || expected.length < 8 || !got || !(await safeEqual(got, expected))) {
    return jsonError(c, 401, 'unauthorized');
  }
  await next();
};

/** Resolve an owner token (`wto_…`) to its non-deleted agent, or null. */
export async function agentByOwnerToken(env: Bindings, token: string): Promise<AgentRow | null> {
  if (typeof token !== 'string' || !/^wto_[A-Za-z0-9]{20,80}$/.test(token)) return null;
  return env.DB.prepare('SELECT * FROM agents WHERE owner_token_hash = ? AND deleted_at IS NULL')
    .bind(await sha256Hex(token)).first<AgentRow>();
}

/** Salted hash of the client IP (for rate limits). Never store raw IPs. */
export async function clientIpHash(c: Context<AppEnv>): Promise<string> {
  const ip = c.req.header('cf-connecting-ip')
    || c.req.header('x-real-ip')
    || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
  return (await sha256Hex(`${c.env.HASH_SALT ?? 'wisptrace'}:ip:${ip}`)).slice(0, 32);
}
