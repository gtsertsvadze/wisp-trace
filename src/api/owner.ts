// Owner API: the private view of one agent's traces, authorised by the owner token (`Authorization: Bearer wto_…`).
// Raw (masked) traces leave the server only here. Every response is no-store.
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { agentByOwnerToken } from '../lib/auth';
import { jsonError } from '../lib/http';
import {
  deleteAllOwnerTraces, deleteOwnerAgent, deleteOwnerTrace, getOwnerTrace, listOwnerTraces, ownerTotals, setTraceSensitive,
} from '../data/owner';

const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '');
  const agent = m ? await agentByOwnerToken(c.env, m[1]) : null;
  if (!agent) return jsonError(c, 401, 'unauthorized', 'Missing or invalid owner token.');
  c.set('agent', agent);
  await next();
};

const app = new Hono<AppEnv>();
app.use('*', requireOwner);

app.get('/traces', async c => {
  const agent = c.var.agent;
  const limit = Number(c.req.query('limit') ?? '') || undefined;
  const [page, totals] = await Promise.all([
    listOwnerTraces(c.env, agent.id, { cursor: c.req.query('cursor'), limit }),
    c.req.query('cursor') ? Promise.resolve(undefined) : ownerTotals(c.env, agent.id),
  ]);
  return c.json({
    ok: true,
    agent: { name: agent.name, app: agent.app, model: agent.model, owner_handle: agent.owner_handle, claimed_at: agent.claimed_at },
    ...(totals ? { totals } : {}),
    items: page.items,
    cursor: page.cursor,
  });
});

app.get('/traces/:id', async c => {
  const d = await getOwnerTrace(c.env, c.var.agent.id, c.req.param('id'));
  if (!d) return jsonError(c, 404, 'trace_not_found');
  return c.json({ ok: true, trace: d.trace, raw: d.raw, raw_missing: d.raw_missing });
});

// Mark a trace sensitive (or not): body { "sensitive": true | false }.
app.post('/traces/:id/sensitive', async c => {
  const body = await c.req.json<{ sensitive?: unknown }>().catch(() => null);
  if (!body || typeof body.sensitive !== 'boolean') return jsonError(c, 400, 'invalid_body', 'Send { "sensitive": true } or { "sensitive": false }.');
  const ok = await setTraceSensitive(c.env, c.var.agent.id, c.req.param('id'), body.sensitive);
  if (!ok) return jsonError(c, 404, 'trace_not_found');
  return c.json({ ok: true, sensitive: body.sensitive });
});

app.delete('/traces/:id', async c => {
  const ok = await deleteOwnerTrace(c.env, c.var.agent.id, c.req.param('id'));
  if (!ok) return jsonError(c, 404, 'trace_not_found');
  return c.json({ ok: true, deleted: 1 });
});

app.delete('/traces', async c => {
  const deleted = await deleteAllOwnerTraces(c.env, c.var.agent.id);
  return c.json({ ok: true, deleted });
});

app.delete('/agent', async c => {
  const { traces } = await deleteOwnerAgent(c.env, c.var.agent);
  return c.json({ ok: true, deleted: { agent: c.var.agent.name, traces } });
});

export default app;
