// Public website JSON (UI-1): the anonymised live feed and site-wide stats. Mounted at /api/public.
//   GET /live?after=<cursor>&limit=40&filter=all|done|failed -> { items, cursor, stats }
//   GET /stats -> PublicStats
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { feedItems, parseFilter, publicStats } from '../data/live';

const app = new Hono<AppEnv>();

app.get('/live', async c => {
  const limitRaw = Number(c.req.query('limit') ?? 40);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.trunc(limitRaw))) : 40;
  const after = c.req.query('after') || null;
  const filter = parseFilter(c.req.query('filter'));
  const now = Date.now();
  const [feed, stats] = await Promise.all([feedItems(c.env, { limit, filter, after, now }), publicStats(c.env, now)]);
  c.header('Cache-Control', 'public, max-age=3');
  return c.json({
    ok: true,
    items: feed.items,
    cursor: feed.cursor,
    stats: { traces_total: stats.traces_total, per_min: stats.per_min, agents_total: stats.agents_total },
  });
});

app.get('/stats', async c => {
  const stats = await publicStats(c.env);
  c.header('Cache-Control', 'public, max-age=15');
  return c.json(stats);
});

export default app;
