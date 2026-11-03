// Tiny JSON cache in D1 (`snapshots` table) for expensive aggregates.
import type { Bindings } from '../env';

export async function cached<T>(env: Bindings, key: string, maxAgeMs: number, compute: () => Promise<T>): Promise<T> {
  const row = await env.DB.prepare('SELECT json, computed_at FROM snapshots WHERE key = ?').bind(key).first<{ json: string; computed_at: number }>();
  if (row && Date.now() - row.computed_at < maxAgeMs) return JSON.parse(row.json) as T;
  const value = await compute();
  await putSnapshot(env, key, value);
  return value;
}

export async function putSnapshot(env: Bindings, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO snapshots (key, json, computed_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, computed_at = excluded.computed_at',
  ).bind(key, JSON.stringify(value), Date.now()).run();
}

export async function dropSnapshots(env: Bindings, prefix: string): Promise<void> {
  await env.DB.prepare("DELETE FROM snapshots WHERE key LIKE ? || '%'").bind(prefix).run();
}
