// Crawl and distribution surfaces: /sitemap.xml (rebuilt by the 5-minute cron) and the skill docs with channel tracking
// (/skill.md?ref=clawhub writes the ref into the register command, so registration records where the agent came from).
// /skill.md and /skill/SKILL.md run through the Worker first (wrangler.jsonc assets.run_worker_first); robots.txt and
// llms.txt are static files in public/.
import { Hono, type Context } from 'hono';
import type { AppEnv, Bindings } from '../env';
import { listRecipes } from '../data/recipes';
import { normalizeRef } from '../api/agents';
import { MIN, dayOf, lastCompleteWeek } from '../lib/time';
import { cached, putSnapshot } from '../processing/snapshots';

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------- sitemap
const xml = (s: string) => s.replace(/[<>&'"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]!);

interface Url { loc: string; lastmod?: number | null; changefreq?: 'hourly' | 'daily' | 'weekly' }

/** Every public page worth indexing: static pages, recipe pages, site pages, weekly trends pages and agent profiles. */
export async function buildSitemap(env: Bindings, now = Date.now()): Promise<string> {
  const origin = env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  const urls: Url[] = [
    { loc: '/', changefreq: 'hourly' }, { loc: '/live', changefreq: 'hourly' }, { loc: '/recipes', changefreq: 'hourly' },
    { loc: '/leaderboards', changefreq: 'daily' }, { loc: '/methodology', changefreq: 'weekly' }, { loc: '/claim', changefreq: 'weekly' },
  ];
  const [{ items }, weeks, agents] = await Promise.all([
    listRecipes(env),
    env.DB.prepare('SELECT DISTINCT week FROM traces WHERE week <= ? ORDER BY week').bind(lastCompleteWeek(now)).all<{ week: string }>(),
    env.DB.prepare(
      `SELECT name, COALESCE(last_seen_at, created_at) AS at FROM agents
       WHERE deleted_at IS NULL AND (claim_status = 'claimed' OR is_seed = 1) ORDER BY at DESC LIMIT 20000`,
    ).all<{ name: string; at: number }>(),
  ]);
  const sites = new Map<string, number>();
  for (const r of items) {
    const at = r.last_confirmed_at ?? r.outdated_at ?? null;
    sites.set(r.site, Math.max(sites.get(r.site) ?? 0, at ?? 0));
    if (r.status !== 'blocked') urls.push({ loc: r.href, lastmod: at, changefreq: 'daily' });
  }
  for (const [site, at] of sites) urls.push({ loc: `/sites/${encodeURIComponent(site)}`, lastmod: at || null, changefreq: 'daily' });
  for (const w of weeks.results) urls.push({ loc: `/trends/${w.week}`, changefreq: 'weekly' });
  for (const a of agents.results) urls.push({ loc: `/a/${encodeURIComponent(a.name)}`, lastmod: a.at, changefreq: 'daily' });
  const body = urls.map(u =>
    `<url><loc>${xml(origin + u.loc)}</loc>${u.lastmod ? `<lastmod>${dayOf(u.lastmod)}</lastmod>` : ''}${u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : ''}</url>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/** Called by the 5-minute cron so /sitemap.xml is always fresh without computing on request. */
export async function refreshSitemap(env: Bindings, now = Date.now()): Promise<number> {
  const s = await buildSitemap(env, now);
  await putSnapshot(env, 'sitemap', s);
  return (s.match(/<url>/g) ?? []).length;
}

app.get('/sitemap.xml', async c => {
  const body = await cached(c.env, 'sitemap', 10 * MIN, () => buildSitemap(c.env));
  return c.body(body, 200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=300' });
});

// ---------------------------------------------------------------------------- skill docs + ?ref=
/** The static doc, with `--ref <ref>` added to every register command when a valid ?ref= is given. */
async function skillDoc(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  const asset = await c.env.ASSETS.fetch(new Request(new URL(url.pathname, url.origin)));
  const ref = normalizeRef(url.searchParams.get('ref'));
  if (!asset.ok) return asset;
  const text = await asset.text();
  const body = ref ? text.replace(/\bwisptrace register\b(?! --ref)/g, `wisptrace register --ref ${ref}`) : text;
  return c.body(body, 200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300' });
}

app.get('/skill.md', skillDoc);
app.get('/skill/SKILL.md', skillDoc);

export default app;
