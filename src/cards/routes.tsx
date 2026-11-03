// Shareable image cards (1200x630). Every route serves `.svg` and `.png`; PNGs are cached in caches.default.
//   /card/agent/:name.(png|svg)          /card/award/:week/:award.(png|svg)   /card/board/:board.(png|svg)[?week=]
//   /card/trend(s)/:week.(png|svg)          /card/recipe/:site/:slug.(png|svg)   /card/stat.(png|svg)[?date=YYYY-MM-DD]
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import type { AwardId } from '../types';
import { dayOf, isoWeek, lastCompleteWeek } from '../lib/time';
import { AWARD_IDS, BOARDS, agentCardData, awardCardData, boardCardData, isWeek, recipeCardData, trendCardData, type Board } from './data';
import { renderPng } from './png';
import { isDate, statCardData, statOfTheDay } from './stat';
import { agentCard, awardCard, boardCard, recipeCard, statCard, trendCard } from './svg';

const app = new Hono<AppEnv>();
type Ctx = Context<AppEnv>;
type Format = 'png' | 'svg';

const CACHE_CONTROL = 'public, max-age=600';
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com";

function parseFile(file: string): { id: string; fmt: Format } | null {
  const m = /^(.+)\.(png|svg)$/.exec(file);
  return m ? { id: m[1], fmt: m[2] as Format } : null;
}

const notFound = (c: Ctx) => c.text('Card not found', 404, { 'Cache-Control': 'public, max-age=60' });

/** `build(forBrowser)` returns the SVG or null for 404. SVGs for browsers also @import the web fonts. */
async function serve(c: Ctx, fmt: Format, build: (forBrowser: boolean) => Promise<string | null>): Promise<Response> {
  if (fmt === 'svg') {
    const svg = await build(true);
    if (!svg) return notFound(c);
    return c.body(svg, 200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': CACHE_CONTROL, 'Content-Security-Policy': SVG_CSP });
  }

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(new URL(c.req.url).toString(), { method: 'GET' });
  try {
    const hit = await cache?.match(key);
    if (hit) return new Response(hit.body, hit); // fresh headers object (cached ones are immutable)
  } catch { /* cache unavailable */ }

  const svg = await build(false);
  if (!svg) return notFound(c);
  let png: Uint8Array;
  try {
    png = await renderPng(svg);
  } catch (err) {
    console.error('card render failed', c.req.path, err instanceof Error ? err.message : String(err));
    return c.text('Card temporarily unavailable', 503, { 'Cache-Control': 'no-store', 'Retry-After': '60' });
  }
  const res = new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': CACHE_CONTROL } });
  if (cache) {
    const put = cache.put(key, res.clone()).catch(() => {});
    try { c.executionCtx.waitUntil(put); } catch { await put; }
  }
  return res;
}

app.get('/agent/:file', async c => {
  const f = parseFile(c.req.param('file'));
  if (!f || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(f.id)) return notFound(c);
  return serve(c, f.fmt, async fb => {
    const d = await agentCardData(c.env, f.id);
    return d ? agentCard(d, fb) : null;
  });
});

app.get('/award/:week/:file', async c => {
  const week = c.req.param('week');
  const f = parseFile(c.req.param('file'));
  if (!f || !isWeek(week) || !AWARD_IDS.includes(f.id as AwardId)) return notFound(c);
  return serve(c, f.fmt, async fb => {
    const d = await awardCardData(c.env, week, f.id as AwardId);
    return d ? awardCard(d, fb) : null;
  });
});

app.get('/board/:file', async c => {
  const f = parseFile(c.req.param('file'));
  const week = c.req.query('week') ?? isoWeek(Date.now());
  if (!f || !BOARDS.includes(f.id as Board) || !isWeek(week)) return notFound(c);
  return serve(c, f.fmt, async fb => boardCard(await boardCardData(c.env, f.id as Board, week), fb));
});

// /card/trends/:week.png matches the /trends/:week page; /card/trend/ is the original path.
for (const path of ['/trend/:file', '/trends/:file']) {
  app.get(path, async c => {
    const f = parseFile(c.req.param('file') ?? '');
    if (!f) return notFound(c);
    const week = f.id === 'latest' ? lastCompleteWeek(Date.now()) : f.id;
    if (!isWeek(week)) return notFound(c);
    return serve(c, f.fmt, async fb => trendCard(await trendCardData(c.env, week), fb));
  });
}

app.get('/recipe/:site/:file', async c => {
  const site = c.req.param('site').toLowerCase();
  const f = parseFile(c.req.param('file'));
  if (!f || !/^[a-z0-9.-]{3,253}$/.test(site) || !/^[a-z0-9-]{1,80}$/.test(f.id)) return notFound(c);
  return serve(c, f.fmt, async fb => {
    const d = await recipeCardData(c.env, site, f.id);
    return d ? recipeCard(d, fb) : null;
  });
});

app.get('/:file', async c => {
  const f = parseFile(c.req.param('file'));
  if (!f || f.id !== 'stat') return notFound(c);
  const today = dayOf(Date.now());
  const date = c.req.query('date') ?? today;
  if (!isDate(date) || date > today) return notFound(c);
  return serve(c, f.fmt, async fb => statCard(statCardData(c.env, date, await statOfTheDay(c.env, date)), fb));
});

export default app;
