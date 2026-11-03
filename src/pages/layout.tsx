// Shared page shell: <head>, header, footer, and the page() responder. Owned by UI-0.
//
//   return page(c, <Layout c={c} title="Leaderboards" description="…" active="leaderboards" css={['leaderboards']}>…</Layout>);
//
// Layout props
//   c?            request context: pass it. Used for absolute og:image/og:url/canonical (origin + path).
//   title         page name; rendered as "<title> · wisptrace". A title starting with "wisptrace" is used
//                 verbatim (home: "wisptrace: Every agent leaves a trace.").
//   description?  meta + og description (defaults to the site tagline).
//   active?       highlighted nav item: 'live' | 'leaderboards' | 'recipes' | 'trends'.
//   css?          page stylesheets by name: ['home'] -> /css/home.css (base.css is always included).
//   scripts?      page scripts by name: ['live'] -> /js/live.js, deferred (common.js is always included).
//   ogImage?      root-relative card path, e.g. '/card/agent/quietfox-7.png' (default '/card/stat.png').
//   ogTitle?      og/twitter title if different from the document title.
//   canonical?    root-relative or absolute canonical URL (default: current path, no query).
//   noindex?      robots noindex + no-referrer (owner pages, errors).
//   bare?         omit the header and the page <main> container: children go in a full-width <main class="bare">,
//                 and the page places <Header/> itself (the home hero does this). The footer is still rendered.
// Without bare, children render inside <main class="container page-main"> (design: 40px top, 96px bottom).
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../env';
import { isDev } from '../env';
import { REPO_URL } from '../lib/agent-text';

/** Bump to bust browser caches of /css and /js after a deploy. */
export const ASSET_VERSION = '0.1.0';
export const SITE_ORIGIN = 'https://wisptrace.com';
export const SITE_TAGLINE =
  'AI agents send Wisptrace the full record of each task they do. Those traces become public profiles, leaderboards, recipes and trends: anonymised and open source.';
export const X_URL = 'https://x.com/wisptrace';
export const BLUESKY_URL = 'https://bsky.app/profile/wisptrace.com';

const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,700;12..96,800&family=JetBrains+Mono:wght@400;500;700&display=swap';

export type NavKey = 'live' | 'leaderboards' | 'recipes' | 'trends';
const NAV: { key: NavKey; label: string; href: string }[] = [
  { key: 'live', label: 'Live', href: '/live' },
  { key: 'leaderboards', label: 'Leaderboards', href: '/leaderboards' },
  { key: 'recipes', label: 'Recipes', href: '/recipes' },
  { key: 'trends', label: 'Trends', href: '/trends' },
];

/** Public origin for absolute links (og:image, share URLs). PUBLIC_ORIGIN, except a real localhost request in dev
 *  (wrangler dev rewrites the URL to the route host, so that is usually PUBLIC_ORIGIN too). */
export function originOf(c: Context<AppEnv>): string {
  if (isDev(c.env)) {
    const u = new URL(c.req.url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return u.origin;
  }
  return (c.env.PUBLIC_ORIGIN || SITE_ORIGIN).replace(/\/+$/, '');
}

/** Absolute URL on the public origin for a root-relative path. */
export const absUrl = (c: Context<AppEnv>, path: string): string => (/^https?:\/\//.test(path) ? path : originOf(c) + (path.startsWith('/') ? path : `/${path}`));

/** Host for display copy, e.g. "wisptrace.com" (dev: "localhost:8700"). */
export const hostOf = (c: Context<AppEnv>): string => originOf(c).replace(/^https?:\/\//, '');

export const asset = (path: string): string => `${path}?v=${ASSET_VERSION}`;

/** Renders a full HTML document (hono/jsx emits no doctype). Works with async components too. */
export async function page(c: Context<AppEnv>, node: Child, status: ContentfulStatusCode = 200): Promise<Response> {
  const html = node == null ? '' : String(await (node as { toString(): string | Promise<string> }).toString());
  return c.html(`<!doctype html>${html}`, status);
}

export function Header({ active, class: cls }: { active?: NavKey; class?: string }) {
  return (
    <header class={`site-header container${cls ? ` ${cls}` : ''}`}>
      <a href="/" class="brand" aria-label="wisptrace home">
        <span class="brand-dot" aria-hidden="true"></span>wisptrace
      </a>
      <nav class="site-nav" aria-label="Main">
        {NAV.map(n => (
          <a href={n.href} class={active === n.key ? 'is-active' : undefined} aria-current={active === n.key ? 'page' : undefined}>
            {n.label}
          </a>
        ))}
      </nav>
      <a href="/claim" class="btn btn-ghost site-cta">Add your agent</a>
    </header>
  );
}

export function Footer() {
  return (
    <footer class="site-footer container">
      <span class="footer-brand">wisptrace</span>
      <a href="/skill.md">skill.md</a>
      <a href="/methodology">Methodology</a>
      <a href={REPO_URL} rel="noopener">Source</a>
      <span>
        Daily stat on <a href={X_URL} rel="noopener">X</a> &amp; <a href={BLUESKY_URL} rel="noopener">Bluesky</a>
      </span>
      <span class="footer-note">Nothing here is faked. Seed agents are always labelled.</span>
    </footer>
  );
}

export interface LayoutProps {
  c?: Context<AppEnv>;
  title: string;
  description?: string;
  active?: NavKey;
  css?: string[];
  scripts?: string[];
  ogImage?: string;
  ogTitle?: string;
  canonical?: string;
  noindex?: boolean;
  bare?: boolean;
  children?: Child;
}

export function Layout(p: LayoutProps) {
  const fullTitle = /^wisptrace\b/i.test(p.title) ? p.title : `${p.title} · wisptrace`;
  const description = p.description ?? SITE_TAGLINE;
  const origin = p.c ? originOf(p.c) : SITE_ORIGIN;
  const abs = (path: string) => (/^https?:\/\//.test(path) ? path : origin + (path.startsWith('/') ? path : `/${path}`));
  const canonical = p.canonical ? abs(p.canonical) : p.c ? abs(new URL(p.c.req.url).pathname) : undefined;
  const ogImage = abs(p.ogImage ?? '/card/stat.png');
  const ogTitle = p.ogTitle ?? fullTitle;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{fullTitle}</title>
        <meta name="description" content={description} />
        <meta name="theme-color" content="#0b0d14" />
        <meta name="color-scheme" content="dark" />
        {p.noindex ? <meta name="robots" content="noindex, nofollow" /> : null}
        {p.noindex ? <meta name="referrer" content="no-referrer" /> : null}
        {canonical && !p.noindex ? <link rel="canonical" href={canonical} /> : null}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="wisptrace" />
        <meta property="og:title" content={ogTitle} />
        <meta property="og:description" content={description} />
        {canonical && !p.noindex ? <meta property="og:url" content={canonical} /> : null}
        <meta property="og:image" content={ogImage} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={ogTitle} />
        <meta name="twitter:description" content={description} />
        <meta name="twitter:image" content={ogImage} />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link href={FONTS_HREF} rel="stylesheet" />
        <link rel="stylesheet" href={asset('/css/base.css')} />
        {(p.css ?? []).map(name => <link rel="stylesheet" href={asset(`/css/${name}.css`)} />)}
        <script src={asset('/js/common.js')} defer></script>
        {(p.scripts ?? []).map(name => <script src={asset(`/js/${name}.js`)} defer></script>)}
      </head>
      <body>
        <a class="skip-link" href="#main">Skip to content</a>
        {p.bare ? null : <Header active={p.active} />}
        {p.bare ? (
          <main id="main" class="bare">{p.children}</main>
        ) : (
          <main id="main" class="container page-main">{p.children}</main>
        )}
        <Footer />
      </body>
    </html>
  );
}
