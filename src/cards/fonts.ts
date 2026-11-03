// TTF buffers for resvg, fetched from Google Fonts at runtime (not bundled), kept in module scope per isolate
// and in the Cache API across isolates. resvg can't use woff2 or variable axes, so we load static instances:
// Bricolage Grotesque opsz-14 400/600/700 (family "Bricolage Grotesque"), opsz-96 800 (family
// "Bricolage Grotesque 96pt", used for display headlines) and JetBrains Mono 400/700.

interface FontSpec { id: string; url: string; css: string }

const GSTATIC = 'https://fonts.gstatic.com/s';
const FONTS: FontSpec[] = [
  { id: 'bricolage-14-400', url: `${GSTATIC}/bricolagegrotesque/v9/3y9U6as8bTXq_nANBjzKo3IeZx8z6up5BeSl5jBNz_19PpbpMXuECpwUxJBOm_OJWiaaD30YfKfjZZoLvRviyM0.ttf`, css: 'Bricolage+Grotesque:opsz,wght@14,400' },
  { id: 'bricolage-14-600', url: `${GSTATIC}/bricolagegrotesque/v9/3y9U6as8bTXq_nANBjzKo3IeZx8z6up5BeSl5jBNz_19PpbpMXuECpwUxJBOm_OJWiaaD30YfKfjZZoLvcXlyM0.ttf`, css: 'Bricolage+Grotesque:opsz,wght@14,600' },
  { id: 'bricolage-14-700', url: `${GSTATIC}/bricolagegrotesque/v9/3y9U6as8bTXq_nANBjzKo3IeZx8z6up5BeSl5jBNz_19PpbpMXuECpwUxJBOm_OJWiaaD30YfKfjZZoLvfzlyM0.ttf`, css: 'Bricolage+Grotesque:opsz,wght@14,700' },
  { id: 'bricolage-96-800', url: `${GSTATIC}/bricolagegrotesque/v9/3y9U6as8bTXq_nANBjzKo3IeZx8z6up5BeSl5jBNz_19PpZJMnuECpwUxJBOm_OJWiaaD30YfKfjZZoLvZvlyM0.ttf`, css: 'Bricolage+Grotesque:opsz,wght@96,800' },
  { id: 'jetbrains-400', url: `${GSTATIC}/jetbrainsmono/v24/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKxjPQ.ttf`, css: 'JetBrains+Mono:wght@400' },
  { id: 'jetbrains-700', url: `${GSTATIC}/jetbrainsmono/v24/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8L6tjPQ.ttf`, css: 'JetBrains+Mono:wght@700' },
];

const CACHE_KEY = (id: string) => `https://wisptrace.com/__fonts/v1/${id}.ttf`;
const TTL = 60 * 60 * 24 * 30;

let loading: Promise<Uint8Array[]> | null = null;

/** All card fonts, loaded once per isolate. A failed load is retried on the next call. */
export function loadFonts(): Promise<Uint8Array[]> {
  loading ??= Promise.all(FONTS.map(loadFont)).catch(err => {
    loading = null;
    throw err;
  });
  return loading;
}

const isFont = (b: Uint8Array) =>
  b.length > 1024 && ((b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || String.fromCharCode(b[0], b[1], b[2], b[3]) === 'OTTO' || String.fromCharCode(b[0], b[1], b[2], b[3]) === 'true');

async function loadFont(f: FontSpec): Promise<Uint8Array> {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = CACHE_KEY(f.id);
  try {
    const hit = await cache?.match(key);
    if (hit) {
      const b = new Uint8Array(await hit.arrayBuffer());
      if (isFont(b)) return b;
    }
  } catch { /* cache unavailable: fetch */ }

  let buf = await fetchTtf(f.url);
  // Pinned URL gone (Google bumped the font version): discover the current one through the CSS API.
  if (!buf) {
    const css = await fetch(`https://fonts.googleapis.com/css2?family=${f.css}`, { headers: { 'User-Agent': 'Mozilla/4.0' } })
      .then(r => (r.ok ? r.text() : '')).catch(() => '');
    const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/.exec(css)?.[1];
    if (url) buf = await fetchTtf(url);
  }
  if (!buf) throw new Error(`font unavailable: ${f.id}`);
  try {
    await cache?.put(key, new Response(buf, { headers: { 'Content-Type': 'font/ttf', 'Cache-Control': `public, max-age=${TTL}` } }));
  } catch { /* best effort */ }
  return buf;
}

async function fetchTtf(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { cf: { cacheTtl: TTL, cacheEverything: true } });
    if (!res.ok) return null;
    const b = new Uint8Array(await res.arrayBuffer());
    return isFont(b) ? b : null;
  } catch {
    return null;
  }
}
