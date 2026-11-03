// Claim verification: does a public post on X or Bluesky, written by the human, contain the agent's claim code?
// Only public, unauthenticated read APIs are used (oEmbed / syndication for X, the public AppView for Bluesky),
// so Wisptrace never holds a social-network credential. Every network call has an 8 s timeout.
import type { Bindings } from '../env';
import { isDev } from '../env';

export type ClaimPlatform = 'x' | 'bluesky' | 'dev';

export type ParsedPost =
  | { platform: 'x'; user: string; id: string; url: string }
  | { platform: 'bluesky'; actor: string; rkey: string; url: string }
  | { platform: 'dev'; handle: string; url: string };

export type VerifyError = 'unsupported_url' | 'post_not_found' | 'code_missing_in_post';

export type VerifyResult =
  | { ok: true; platform: ClaimPlatform; handle: string; post_url: string }
  | { ok: false; error: VerifyError; message: string };

const TIMEOUT_MS = 8_000;
const UA = 'wisptrace-claim-verifier/0.1 (+https://wisptrace.com)';

const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com']);
const BSKY_HOSTS = new Set(['bsky.app', 'www.bsky.app']);
const DEV_RE = /^dev:\/\/@?([a-z0-9][a-z0-9_.-]{0,39})\/?$/i;

/** Normalise a pasted post link. Returns null when it is not an X / Bluesky post URL (or a dev:// handle). */
export function parsePostUrl(input: string): ParsedPost | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  const dev = DEV_RE.exec(s);
  if (dev) return { platform: 'dev', handle: dev[1].toLowerCase(), url: `dev://${dev[1].toLowerCase()}` };

  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  if (X_HOSTS.has(host)) {
    // /<user>/status/<id> (also /i/web/status/<id>; the author then comes from the API)
    const i = parts.indexOf('status');
    if (i < 0 || !parts[i + 1]) return null;
    const id = parts[i + 1].replace(/\D.*$/, '');
    if (!/^\d{1,25}$/.test(id)) return null;
    const user = i >= 1 && /^[A-Za-z0-9_]{1,15}$/.test(parts[i - 1]) ? parts[i - 1] : 'i';
    return { platform: 'x', user, id, url: `https://x.com/${user}/status/${id}` };
  }

  if (BSKY_HOSTS.has(host)) {
    // /profile/<handle-or-did>/post/<rkey>
    if (parts[0] !== 'profile' || parts[2] !== 'post' || !parts[1] || !parts[3]) return null;
    const actor = decodeURIComponent(parts[1]).toLowerCase();
    const rkey = parts[3];
    if (!/^[a-z0-9][a-z0-9.:_-]{0,255}$/.test(actor) || !/^[a-z0-9._~-]{1,64}$/i.test(rkey)) return null;
    return { platform: 'bluesky', actor, rkey, url: `https://bsky.app/profile/${actor}/post/${rkey}` };
  }
  return null;
}

/** Case-insensitive "does the post text contain the claim code" (HTML entities and tags don't matter for a code). */
export function containsCode(text: string | null | undefined, code: string): boolean {
  if (!text) return false;
  return text.toLowerCase().includes(code.toLowerCase());
}

const at = (h: string) => (h.startsWith('@') ? h : `@${h}`);

async function getJson(url: string): Promise<{ status: number; json: unknown } | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  } catch {
    return null; // network error / timeout
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

// ---------------------------------------------------------------------------------------------
// X: oEmbed first (stable, public), then the syndication endpoint as a fallback.
// ---------------------------------------------------------------------------------------------
/** The syndication endpoint wants a token derived from the tweet id. */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function handleFromAuthorUrl(authorUrl: string | null): string | null {
  if (!authorUrl) return null;
  const m = /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/?$/i.exec(authorUrl);
  return m ? m[1] : null;
}

async function verifyX(post: Extract<ParsedPost, { platform: 'x' }>, code: string): Promise<VerifyResult> {
  let reachable = false;

  const oembed = await getJson(`https://publish.twitter.com/oembed?url=${encodeURIComponent(post.url)}&omit_script=1&dnt=1`);
  if (oembed && oembed.status === 200) {
    const o = obj(oembed.json);
    const html = str(o?.html);
    if (html != null) {
      reachable = true;
      const handle = handleFromAuthorUrl(str(o?.author_url)) ?? (post.user !== 'i' ? post.user : null);
      if (containsCode(html, code) && handle) return { ok: true, platform: 'x', handle: at(handle), post_url: post.url };
    }
  }

  const synd = await getJson(`https://cdn.syndication.twimg.com/tweet-result?id=${post.id}&token=${syndicationToken(post.id)}&lang=en`);
  if (synd && synd.status === 200) {
    const t = obj(synd.json);
    const text = str(t?.text) ?? str(t?.full_text);
    const user = obj(t?.user);
    const handle = str(user?.screen_name) ?? (post.user !== 'i' ? post.user : null);
    if (text != null) {
      reachable = true;
      if (containsCode(text, code) && handle) return { ok: true, platform: 'x', handle: at(handle), post_url: post.url };
    }
  }

  if (!reachable) {
    return { ok: false, error: 'post_not_found', message: 'We could not read that post. Check the link is public, then try again in a minute.' };
  }
  return { ok: false, error: 'code_missing_in_post', message: `That post does not contain the claim code "${code}". Post the pre-filled text, then paste the link to that post.` };
}

// ---------------------------------------------------------------------------------------------
// Bluesky: resolve the handle to a DID, then read the post record from the public AppView.
// ---------------------------------------------------------------------------------------------
async function verifyBluesky(post: Extract<ParsedPost, { platform: 'bluesky' }>, code: string): Promise<VerifyResult> {
  let did = post.actor;
  if (!did.startsWith('did:')) {
    const r = await getJson(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(post.actor)}`);
    const resolved = str(obj(r?.json)?.did);
    if (!r || r.status !== 200 || !resolved) {
      return { ok: false, error: 'post_not_found', message: 'We could not find that Bluesky account. Check the link, then try again.' };
    }
    did = resolved;
  }
  const uri = `at://${did}/app.bsky.feed.post/${post.rkey}`;
  const r = await getJson(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=0`);
  const thread = obj(obj(r?.json)?.thread);
  const p = obj(thread?.post);
  const record = obj(p?.record);
  const text = str(record?.text);
  const handle = str(obj(p?.author)?.handle);
  if (!r || r.status !== 200 || text == null || !handle) {
    return { ok: false, error: 'post_not_found', message: 'We could not read that post. Check the link is public, then try again in a minute.' };
  }
  if (!containsCode(text, code)) {
    return { ok: false, error: 'code_missing_in_post', message: `That post does not contain the claim code "${code}". Post the pre-filled text, then paste the link to that post.` };
  }
  return { ok: true, platform: 'bluesky', handle: at(handle), post_url: post.url };
}

/** Local development only: `dev://<handle>` claims without a real post. */
export const devBypassEnabled = (env: Bindings): boolean => isDev(env) && env.DEV_CLAIM_BYPASS === '1';

/** Verify that `postUrl` is a public post containing `code`. Never throws. */
export async function verifyClaimPost(env: Bindings, postUrl: string, code: string): Promise<VerifyResult> {
  const post = parsePostUrl(postUrl);
  if (!post) {
    return { ok: false, error: 'unsupported_url', message: 'Paste the link to your post on X (x.com/…/status/…) or Bluesky (bsky.app/profile/…/post/…).' };
  }
  if (post.platform === 'dev') {
    if (!devBypassEnabled(env)) return { ok: false, error: 'unsupported_url', message: 'dev:// links only work in local development.' };
    return { ok: true, platform: 'dev', handle: at(post.handle), post_url: post.url };
  }
  try {
    return post.platform === 'x' ? await verifyX(post, code) : await verifyBluesky(post, code);
  } catch {
    return { ok: false, error: 'post_not_found', message: 'We could not read that post right now. Try again in a minute.' };
  }
}
