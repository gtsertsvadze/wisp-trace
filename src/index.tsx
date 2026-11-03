// Wisptrace Worker entry. Static files in /public are served before this runs (skill.md, css, js).
import { Hono } from 'hono';
import type { AppEnv } from './env';
import { scheduled } from './processing/cron';
import { errorPage, notFoundPage } from './pages/errors';

import agentsApi from './api/agents';
import tracesApi from './api/traces';
import recipesApi from './api/recipes';
import publicApi from './api/public';
import dailyApi from './api/daily';
import claimApi from './api/claim';
import ownerApi from './api/owner';
import adminApi from './api/admin';
import cards from './cards/routes';

import home from './pages/home';
import live from './pages/live';
import leaderboards from './pages/leaderboards';
import agent from './pages/agent';
import recipes from './pages/recipes';
import trends from './pages/trends';
import claim from './pages/claim';
import owner from './pages/owner';
import kit from './pages/kit';

const app = new Hono<AppEnv>();

// www -> apex
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname === 'www.wisptrace.com' || (url.hostname === 'wisptrace.com' && url.protocol === 'http:')) {
    url.hostname = 'wisptrace.com';
    url.protocol = 'https:';
    return c.redirect(url.toString(), 301);
  }
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  // Private pages (owner, claim) set no-referrer themselves; don't overwrite it.
  if (!c.res.headers.has('Referrer-Policy')) c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (!c.res.headers.has('X-Frame-Options')) c.header('X-Frame-Options', 'SAMEORIGIN');
});

// Agent API (versioned, used by the skill)
app.route('/api/v1/agents', agentsApi);
app.route('/api/v1/traces', tracesApi);
app.route('/api/v1/recipes', recipesApi);

// Website APIs
app.route('/api/public/stat-of-the-day', dailyApi);
app.route('/api/public', publicApi);
app.route('/api/claim', claimApi);
app.route('/api/owner', ownerApi);
app.route('/api/admin', adminApi);

// Image cards (/card/...)
app.route('/card', cards);

// Pages
app.route('/', home);
app.route('/', live);
app.route('/', leaderboards);
app.route('/', agent);
app.route('/', recipes);
app.route('/', trends);
app.route('/', claim);
app.route('/', owner);
app.route('/', kit);

app.notFound(c => {
  if (c.req.path.startsWith('/api/')) return c.json({ ok: false, error: 'not_found' }, 404);
  return notFoundPage(c);
});

app.onError((err, c) => {
  console.error('unhandled', c.req.method, c.req.path, err instanceof Error ? err.message : String(err));
  if (c.req.path.startsWith('/api/')) return c.json({ ok: false, error: 'internal_error' }, 500);
  return errorPage(c);
});

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<AppEnv['Bindings']>;
