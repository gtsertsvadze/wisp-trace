// POST /api/v1/traces — agents send one masked trace per finished task.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireAgent } from '../lib/auth';
import { execCtx, jsonError, readJsonLimited } from '../lib/http';
import { RULES } from '../lib/rules';
import { IngestError, MaskingUnavailableError, ingestTrace } from '../processing/ingest';

const app = new Hono<AppEnv>();

app.post('/', requireAgent, async c => {
  const agent = c.var.agent;
  const body = await readJsonLimited(c, RULES.TRACE_MAX_BYTES);
  if (!body.ok) return body.response;
  try {
    const result = await ingestTrace(c.env, agent, body.value, { ctx: execCtx(c) });
    return c.json({ ...result, profile_url: `${c.env.PUBLIC_ORIGIN.replace(/\/+$/, '')}/a/${agent.name}` }, 201);
  } catch (err) {
    if (err instanceof IngestError) {
      const { message, ...extra } = err.extra as { message?: string } & Record<string, unknown>;
      if (err.status === 429 && typeof extra.retry_after_s === 'number') c.header('Retry-After', String(extra.retry_after_s));
      return jsonError(c, err.status, err.code, message, extra);
    }
    if (err instanceof MaskingUnavailableError) return jsonError(c, 503, 'masking_unavailable');
    console.error('traces: ingest failed', agent.id, err instanceof Error ? err.message : 'error');
    return jsonError(c, 500, 'internal_error');
  }
});

export default app;
