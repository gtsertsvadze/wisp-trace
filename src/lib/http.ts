// Small JSON HTTP helpers shared by the API modules.
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** `{ ok: false, error: code, message?, ...extra }` with the given status. */
export function jsonError(
  c: Context, status: ContentfulStatusCode, code: string, message?: string, extra: Record<string, unknown> = {},
): Response {
  return c.json({ ok: false, error: code, ...(message ? { message } : {}), ...extra }, status);
}

export type JsonBody = { ok: true; value: unknown; bytes: number } | { ok: false; response: Response };

/**
 * Read and parse a JSON body of at most `maxBytes`. Checks the Content-Length header up front and the real
 * byte count while streaming (so a lying or missing header can't push more through). 413 when over,
 * 400 `invalid_json` when it doesn't parse. An empty body parses as `{}` when `allowEmpty` is set.
 */
export async function readJsonLimited(c: Context, maxBytes: number, opts: { allowEmpty?: boolean } = {}): Promise<JsonBody> {
  const tooLarge = () => ({ ok: false as const, response: jsonError(c, 413, 'payload_too_large', undefined, { max_bytes: maxBytes }) });
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();

  const stream = c.req.raw.body;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (stream) {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const ch of chunks) { buf.set(ch, off); off += ch.byteLength; }
  const text = new TextDecoder().decode(buf).trim();
  if (!text) {
    if (opts.allowEmpty) return { ok: true, value: {}, bytes: 0 };
    return { ok: false, response: jsonError(c, 400, 'invalid_json', 'Request body must be JSON.') };
  }
  try {
    return { ok: true, value: JSON.parse(text), bytes: size };
  } catch {
    return { ok: false, response: jsonError(c, 400, 'invalid_json', 'Request body must be JSON.') };
  }
}

/** c.executionCtx throws outside a fetch handler (e.g. tests, cron); return undefined there. */
export function execCtx(c: Context): ExecutionContext | undefined {
  try {
    return c.executionCtx as ExecutionContext;
  } catch {
    return undefined;
  }
}
