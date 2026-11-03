// Storage for MASKED full traces. Uses R2 when the TRACES binding exists, otherwise gzipped rows in D1
// (table trace_raw), so the site runs on accounts without R2. Only ever called with already-masked JSON.
import type { Bindings } from '../env';

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function gunzip(buf: ArrayBuffer): Promise<string> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export async function putRaw(env: Bindings, key: string, json: string): Promise<void> {
  if (env.TRACES) {
    await env.TRACES.put(key, json, { httpMetadata: { contentType: 'application/json' } });
    return;
  }
  await env.DB.prepare(
    'INSERT INTO trace_raw (key, body, bytes, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, bytes = excluded.bytes',
  ).bind(key, await gzip(json), json.length, Date.now()).run();
}

export async function getRaw(env: Bindings, key: string): Promise<string | null> {
  if (env.TRACES) {
    const obj = await env.TRACES.get(key);
    return obj ? obj.text() : null;
  }
  const row = await env.DB.prepare('SELECT body FROM trace_raw WHERE key = ?').bind(key).first<{ body: ArrayBuffer | number[] }>();
  if (!row) return null;
  const body = row.body instanceof ArrayBuffer ? row.body : new Uint8Array(row.body).buffer;
  return gunzip(body);
}

export async function deleteRaw(env: Bindings, keys: string[]): Promise<void> {
  if (!keys.length) return;
  if (env.TRACES) {
    for (let i = 0; i < keys.length; i += 1000) await env.TRACES.delete(keys.slice(i, i + 1000));
    return;
  }
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    await env.DB.prepare(`DELETE FROM trace_raw WHERE key IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).run();
  }
}
