// Fixed-window rate limits in D1 (`rate_limits` table). The window bucket is part of the key, so each
// window is its own row and a single atomic upsert both counts and reads.
import type { Bindings } from '../env';

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;   // epoch ms when the current window ends
  count: number;
}

const bucketKey = (key: string, windowMs: number, now: number) => `${key}:${Math.floor(now / windowMs)}`;
const windowEnd = (windowMs: number, now: number) => (Math.floor(now / windowMs) + 1) * windowMs;

/** Count one hit against `key` and report whether it's within `limit` per `windowMs`. */
export async function hit(env: Bindings, key: string, limit: number, windowMs: number, now = Date.now()): Promise<RateLimitResult> {
  const resetAt = windowEnd(windowMs, now);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET count = count + 1
     RETURNING count`,
  ).bind(bucketKey(key, windowMs, now), resetAt).first<{ count: number }>();
  const count = row?.count ?? 1;
  // Opportunistic cleanup of expired windows (~1 in 50 hits).
  if (Math.random() < 0.02) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now).run().catch(() => {});
  }
  return { ok: count <= limit, remaining: Math.max(0, limit - count), resetAt, count };
}

/** Read the current window's count without counting a hit. */
export async function peek(env: Bindings, key: string, limit: number, windowMs: number, now = Date.now()): Promise<RateLimitResult> {
  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?')
    .bind(bucketKey(key, windowMs, now)).first<{ count: number }>();
  const count = row?.count ?? 0;
  return { ok: count < limit, remaining: Math.max(0, limit - count), resetAt: windowEnd(windowMs, now), count };
}
