// Hand-written 1200x630 SVG cards. Pure string builders: no runtime imports, every inserted string escaped.
// Visual language: docs/design/README.md (dark #0b0d14, mint #8ef0d2 glows, Bricolage 800 + JetBrains Mono).

export const W = 1200;
export const H = 630;
const X = 64;                 // side gutter
const R = W - X;              // right edge of content
const CW = R - X;             // content width

const C = {
  bg: '#0b0d14', panel: '#11141d', text: '#eceef6', bright: '#f6f7fb', dim: '#b4b9cc', mute: '#8d93a8',
  slate: '#3a3f52', slateBar: '#4c5268', mint: '#8ef0d2', coral: '#ff8f7a',
  line: 'rgba(236,238,246,.08)', lineStrong: 'rgba(236,238,246,.16)', mint14: 'rgba(142,240,210,.14)',
};
const SANS = "'Bricolage Grotesque', sans-serif";
// The opsz-96 static instance registers as its own family; browsers fall back to the variable font.
const DISPLAY = "'Bricolage Grotesque 96pt', 'Bricolage Grotesque', sans-serif";
const family = (o: { mono?: boolean; weight?: number }) => (o.mono ? MONO : (o.weight ?? 400) >= 800 ? DISPLAY : SANS);
const MONO = "'JetBrains Mono', monospace";

// ---------------------------------------------------------------------------------------------
// Card data shapes (built by data.ts)
// ---------------------------------------------------------------------------------------------
export interface AgentCardData {
  name: string; app: string; model: string;
  owner: string | null;        // '@mira' when claimed by a human
  seed: boolean;
  isNew: boolean;              // unclaimed or no traces yet -> "joined." variant
  tasks: number; successPct: number; minutes: number; streak: number; bestStreak: number;
  grid: number[];              // 26 weeks x 7 days, column-major, oldest first; -1 = future
  bestAt: { label: string; tasks: number; pct: number }[];
  url: string;                 // 'wisptrace.com/a/quietfox-7'
}

export interface Stat { value: string; unit?: string; label: string; accent?: boolean }

export interface AwardCardData {
  title: string;               // 'Hardest-working agent'
  qualifier?: string;          // 'restaurants'
  weekLabel: string;           // 'WEEK 44 · 26 OCT – 1 NOV'
  subject: string;
  seed: boolean;
  context: string;             // 'OpenClaw on claude-sonnet-4.5 · claimed by @mira'
  stats: Stat[];
  url: string;
}

export interface BoardRow { rank: number; name: string; sub: string; seed: boolean; tasks: number; pct: number; median: number | null }
export interface BoardCardData {
  board: 'agents' | 'models' | 'apps';
  weekLabel: string;
  rows: BoardRow[];
  totalTasks: number;
  rule: string;                // eligibility rule, shown on the empty state + footer
  url: string;
}

export interface TrendBar { label: string; mult: number | null; traces: number }
export interface TrendCardData {
  weekLabel: string;
  headline: { text: string; accent?: boolean }[] | null; // null = not enough data
  bars: TrendBar[];
  mode: 'movers' | 'volume';
  footer: string;
  url: string;
}

export interface RecipeCardData {
  site: string; title: string;
  status: 'trusted' | 'forming' | 'outdated' | 'superseded' | 'blocked';
  version: number;
  trust: string;               // 'o' | 'f' | 'h' per outcome, oldest first
  agents: number; steps: number | null; minutes: number | null;
  path: { kind: 'step' | 'secure' | 'ask_human'; text: string }[];
  totalSteps: number;
  deadEnds: number;
  confirmed: string | null;    // '2 h ago'
  url: string;
}

export interface StatCardData {
  dateLabel: string;           // '3 NOV 2026'
  big: string | null;          // '6.2×'
  headline: { text: string; accent?: boolean }[];
  source: string;
  seed?: boolean;
  url: string;
}

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------
export function esc(s: string | number): string {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
const n = (v: number) => (Math.round(v * 10) / 10).toString();
export const fmtInt = (v: number) => Math.round(v).toLocaleString('en-US');

// Advance widths (1/1000 em) of the Bricolage Grotesque static instances we render with, for ASCII 32..126
// followed by × → · – — …, read from the fonts' hmtx tables. Kerning is ignored (layouts keep slack for it).
const ADV_CHARS = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), ...'×→·–—…'];
const ADV_TABLES: Record<number, string> = {
  400: '253,254,296,605,625,932,756,149,297,277,375,510,149,332,177,349,651,306,573,590,581,594,641,485,640,635,189,171,510,510,510,408,935,657,657,666,686,588,570,698,701,265,349,656,507,893,732,713,621,717,650,635,544,714,648,942,630,580,554,310,333,290,533,589,283,557,608,549,607,564,370,582,596,250,259,546,248,895,596,601,608,607,399,530,371,587,533,809,516,585,488,355,253,326,510,510,605,177,512,749,676',
  600: '238,279,338,619,636,962,755,168,313,303,415,522,180,345,215,357,661,333,593,600,609,604,652,501,650,646,225,204,522,522,522,417,970,684,674,675,695,610,585,713,716,284,365,677,508,924,761,719,638,721,669,647,562,724,665,972,674,621,565,320,349,310,559,566,283,576,628,560,628,576,389,595,619,268,273,576,266,929,619,607,628,628,422,539,389,611,559,845,551,597,512,351,265,337,522,522,622,215,529,785,736',
  700: '230,291,360,626,642,977,754,177,321,316,436,528,196,352,233,361,665,346,603,606,624,610,657,509,656,652,243,220,528,528,528,421,987,698,683,680,700,621,593,721,723,293,373,687,508,939,775,722,646,724,679,652,571,728,673,986,697,642,571,324,357,319,572,554,283,585,638,566,639,581,399,601,631,277,281,591,274,946,631,609,638,639,434,544,397,622,572,863,569,602,524,349,271,342,528,528,631,233,537,803,765',
  800: '203,268,340,613,575,948,697,174,303,303,457,486,193,313,246,349,594,310,551,565,607,565,592,498,608,603,250,235,486,486,486,396,936,659,608,631,621,540,510,649,637,243,323,623,460,822,694,661,586,659,615,585,516,627,632,915,623,595,550,295,349,295,530,527,283,543,576,539,576,537,376,549,562,234,244,541,234,860,562,567,574,574,400,517,368,557,530,799,543,539,483,321,218,321,486,486,590,246,500,775,757',
};
const ADV = new Map<number, Map<string, number>>(Object.entries(ADV_TABLES).map(([w, t]) => {
  const v = t.split(',').map(Number);
  return [Number(w), new Map(ADV_CHARS.map((ch, i) => [ch, v[i] / 1000]))];
}));

/** Advance width of Bricolage Grotesque text at a weight, with letter-spacing in em. */
export function sansWidth(s: string, size: number, weight = 400, trackingEm = 0): number {
  const table = ADV.get(weight >= 800 ? 800 : weight >= 700 ? 700 : weight >= 600 ? 600 : 400)!;
  let em = 0, count = 0;
  for (const ch of s) { em += table.get(ch) ?? 0.62; count++; }
  return size * (em + trackingEm * count);
}
/** JetBrains Mono is fixed-pitch: 600 units per 1000 em. */
export const monoWidth = (s: string, size: number, trackingPx = 0) => [...s].length * (size * 0.6 + trackingPx);

/** Largest font size <= max at which `s` fits `width`. */
export function fitSans(s: string, max: number, width: number, weight = 800, trackingEm = -0.04, min = 28): number {
  const w1 = sansWidth(s, 1, weight, trackingEm);
  return Math.max(min, Math.min(max, Math.floor(width / Math.max(w1, 0.01))));
}

export function truncate(s: string, maxWidth: number, size: number, weight = 400): string {
  if (sansWidth(s, size, weight) <= maxWidth) return s;
  let t = s;
  while (t.length > 1 && sansWidth(t + '…', size, weight) > maxWidth) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

interface TextOpts {
  size: number; fill?: string; weight?: number; mono?: boolean; anchor?: 'start' | 'middle' | 'end';
  ls?: number; opacity?: number; filter?: string; upper?: boolean;
}
function text(x: number, y: number, s: string, o: TextOpts): string {
  const str = o.upper ? s.toUpperCase() : s;
  return `<text x="${n(x)}" y="${n(y)}" font-family="${family(o)}" font-size="${o.size}" font-weight="${o.weight ?? 400}"`
    + ` fill="${o.fill ?? C.text}"${o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : ''}`
    + `${o.ls ? ` letter-spacing="${n(o.ls)}"` : ''}${o.opacity != null ? ` opacity="${o.opacity}"` : ''}`
    + `${o.filter ? ` filter="url(#${o.filter})"` : ''}>${esc(str)}</text>`;
}

/** One <text> with differently coloured runs (e.g. "quietfox-7 " + "joined." in mute). */
function richText(x: number, y: number, runs: { text: string; fill?: string; filter?: string }[], o: TextOpts): string {
  const spans = runs.map(r => `<tspan${r.fill ? ` fill="${r.fill}"` : ''}>${esc(r.text)}</tspan>`).join('');
  return `<text x="${n(x)}" y="${n(y)}" font-family="${family(o)}" font-size="${o.size}" font-weight="${o.weight ?? 400}"`
    + ` fill="${o.fill ?? C.text}"${o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : ''}${o.ls ? ` letter-spacing="${n(o.ls)}"` : ''}>${spans}</text>`;
}

/** Word-wrap rich runs into lines of at most `width`. */
function wrapRuns(runs: { text: string; accent?: boolean }[], size: number, weight: number, trackingEm: number, width: number) {
  const words: { w: string; accent: boolean }[] = [];
  for (const r of runs) for (const w of r.text.split(/\s+/).filter(Boolean)) words.push({ w, accent: !!r.accent });
  const lines: { w: string; accent: boolean }[][] = [[]];
  for (const word of words) {
    const cur = lines[lines.length - 1];
    const candidate = [...cur, word].map(x => x.w).join(' ');
    if (cur.length && sansWidth(candidate, size, weight, trackingEm) > width) lines.push([word]);
    else cur.push(word);
  }
  return lines;
}

function rich(lines: { w: string; accent: boolean }[][], x: number, y: number, lh: number, o: TextOpts, accent = C.mint): string {
  return lines.map((line, i) => {
    const runs: { text: string; fill?: string }[] = [];
    line.forEach((wd, j) => {
      const t = (j ? ' ' : '') + wd.w;
      const last = runs[runs.length - 1];
      if (last && !!last.fill === wd.accent) last.text += t;
      else runs.push({ text: t, fill: wd.accent ? accent : undefined });
    });
    return richText(x, y + i * lh, runs, o);
  }).join('');
}

type ChipKind = 'mint' | 'outline' | 'coral' | 'dim';
function chip(x: number, y: number, label: string, kind: ChipKind, size = 15): { svg: string; w: number } {
  const padX = size * 0.9, h = size * 2.1;
  const w = monoWidth(label, size) + padX * 2;
  const fill = kind === 'mint' ? C.mint14 : kind === 'coral' ? 'rgba(255,143,122,.08)' : 'none';
  const stroke = kind === 'outline' || kind === 'dim' ? C.lineStrong : kind === 'coral' ? 'rgba(255,143,122,.4)' : 'none';
  const ink = kind === 'mint' ? C.mint : kind === 'coral' ? C.coral : kind === 'dim' ? C.dim : C.text;
  return {
    w,
    svg: `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(h / 2)}" fill="${fill}" stroke="${stroke}"/>`
      + text(x + padX, y + h / 2 + size * 0.36, label, { size, mono: true, fill: ink }),
  };
}
function chips(x: number, y: number, items: { label: string; kind: ChipKind }[], size = 15, gap = 10): string {
  let out = '', cx = x;
  for (const it of items) { const c = chip(cx, y, it.label, it.kind, size); out += c.svg; cx += c.w + gap; }
  return out;
}

function panel(x: number, y: number, w: number, h: number, r = 18, highlight = false): string {
  return highlight
    ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${C.panel}"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#hl)" stroke="rgba(142,240,210,.35)"/>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${C.panel}" stroke="${C.line}"/>`;
}

const kicker = (x: number, y: number, s: string, fill = C.mint, anchor: TextOpts['anchor'] = 'start', size = 15) =>
  text(x, y, s, { size, mono: true, fill, ls: size * 0.14, upper: true, anchor });

function brand(x: number, y: number): string {
  return `<circle cx="${x + 6}" cy="${y - 8}" r="13" fill="${C.mint}" opacity=".16"/>`
    + `<circle cx="${x + 6}" cy="${y - 8}" r="6.5" fill="${C.mint}"/>`
    + text(x + 24, y, 'wisptrace', { size: 28, weight: 700, ls: -0.6 });
}

/** Mint-tinted bar track with optional glow on the leader. */
function bar(x: number, y: number, w: number, h: number, frac: number, fill: string, glow = false): string {
  const fw = Math.max(frac > 0 ? h : 0, Math.min(1, frac) * w);
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${h}" rx="${h / 2}" fill="rgba(236,238,246,.08)"/>`
    + (fw > 0 ? `<rect x="${n(x)}" y="${n(y)}" width="${n(fw)}" height="${h}" rx="${h / 2}" fill="${fill}"${glow ? ' filter="url(#glow)"' : ''}/>` : '');
}

// ---------------------------------------------------------------------------------------------
// Frame: background glows, the 72px hero grid, brand, header kicker
// ---------------------------------------------------------------------------------------------
interface FrameOpts { kickerRight?: string; kickerRightMint?: boolean; footerLeft?: string; footerRight?: string; title: string }

export function frame(body: string, o: FrameOpts, forBrowser = false): string {
  const fontCss = forBrowser
    ? `<style>@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700;12..96,800&amp;family=JetBrains+Mono:wght@400;500;700&amp;display=swap');</style>`
    : '';
  const defs = `<defs>${fontCss}
<radialGradient id="g-mint" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(860 -40) scale(900 600)">
<stop offset="0" stop-color="${C.mint}" stop-opacity=".16"/><stop offset=".6" stop-color="${C.mint}" stop-opacity="0"/></radialGradient>
<radialGradient id="g-blue" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(0 220) scale(700 500)">
<stop offset="0" stop-color="#788cff" stop-opacity=".10"/><stop offset=".6" stop-color="#788cff" stop-opacity="0"/></radialGradient>
<radialGradient id="g-low" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1180 680) scale(520 360)">
<stop offset="0" stop-color="${C.mint}" stop-opacity=".09"/><stop offset="1" stop-color="${C.mint}" stop-opacity="0"/></radialGradient>
<linearGradient id="hl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.mint}" stop-opacity=".18"/><stop offset="1" stop-color="${C.mint}" stop-opacity=".04"/></linearGradient>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset=".9" stop-color="#fff" stop-opacity="0"/></linearGradient>
<pattern id="grid" width="72" height="72" patternUnits="userSpaceOnUse" x="-12" y="-12"><path d="M72 0H0V72" fill="none" stroke="rgba(236,238,246,.045)" stroke-width="1"/></pattern>
<mask id="gridmask"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>
<filter id="glow" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="7" result="b"/>
<feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .7 0" result="c"/><feMerge><feMergeNode in="c"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="tglow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="16" result="b"/>
<feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .45 0" result="c"/><feMerge><feMergeNode in="c"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>`;
  const head = brand(X, 84)
    + (o.kickerRight ? kicker(R, 80, o.kickerRight, o.kickerRightMint === false ? C.mute : C.mint, 'end', 14) : '');
  const foot = (o.footerLeft ? text(X, H - 40, o.footerLeft, { size: 15, mono: true, fill: C.mute }) : '')
    + (o.footerRight ? text(R, H - 40, o.footerRight, { size: 15, mono: true, fill: C.mute, anchor: 'end' }) : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<title>${esc(o.title)}</title>${defs}`
    + `<rect width="${W}" height="${H}" fill="${C.bg}"/><rect width="${W}" height="${H}" fill="url(#g-blue)"/>`
    + `<rect width="${W}" height="${H}" fill="url(#g-mint)"/><rect width="${W}" height="${H}" fill="url(#g-low)"/>`
    + `<rect width="${W}" height="${H}" fill="url(#grid)" mask="url(#gridmask)"/>`
    + head + body + foot + `</svg>`;
}

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------
const GRID_CELL_FILL = ['rgba(236,238,246,.06)', 'rgba(142,240,210,.25)', 'rgba(142,240,210,.5)', 'rgba(142,240,210,.75)', C.mint];

function activityGrid(x: number, y: number, cell: number, gap: number, grid: number[]): string {
  const max = Math.max(1, ...grid);
  let out = '';
  grid.forEach((v, i) => {
    if (v < 0) return;
    const col = Math.floor(i / 7), row = i % 7;
    const lvl = v <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4));
    out += `<rect x="${n(x + col * (cell + gap))}" y="${n(y + row * (cell + gap))}" width="${cell}" height="${cell}" rx="3" fill="${GRID_CELL_FILL[lvl]}"/>`;
  });
  return out;
}

function hoursLabel(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function agentCard(d: AgentCardData, forBrowser = false): string {
  if (d.isNew) return newAgentCard(d, forBrowser);
  const ownerChip = d.seed
    ? { label: 'seed · run by Wisptrace', kind: 'mint' as const }
    : { label: `claimed by ${d.owner ?? 'its human'}`, kind: 'mint' as const };
  let b = chips(X, 112, [ownerChip, { label: d.app, kind: 'outline' }, { label: d.model, kind: 'outline' }]);
  const size = fitSans(d.name, 112, CW, 800, -0.04);
  b += text(X - 4, 256, d.name, { size, weight: 800, ls: -0.04 * size, fill: C.bright });

  // stats band
  const py = 284, ph = 108;
  b += panel(X, py, CW, ph, 18);
  const cw = CW / 4;
  const stats: { v: string; unit?: string; label: string; accent?: boolean }[] = [
    { v: fmtInt(d.tasks), label: 'tasks done', accent: true },
    { v: String(d.successPct), unit: '%', label: 'success rate' },
    { v: hoursLabel(d.minutes), label: 'worked' },
    { v: String(d.streak), unit: ' d', label: `streak · best ${d.bestStreak}` },
  ];
  stats.forEach((s, i) => {
    const cx = X + i * cw + 28;
    if (i) b += `<rect x="${n(X + i * cw)}" y="${py + 20}" width="1" height="${ph - 40}" fill="${C.line}"/>`;
    b += richText(cx, py + 60, [{ text: s.v, fill: s.accent ? C.mint : C.text }, ...(s.unit ? [{ text: s.unit, fill: s.unit === '%' ? C.mint : C.mute }] : [])],
      { size: 46, mono: true, weight: 700, ls: -1.6 });
    b += text(cx, py + 88, s.label, { size: 17, fill: C.mute });
  });

  // activity grid (26 weeks x 7 days)
  const gy = 444, cell = 16, gap = 4;
  b += kicker(X, 428, 'activity · 26 weeks', C.mute, 'start', 13);
  b += activityGrid(X, gy, cell, gap, d.grid);

  // best at
  const bx = X + 26 * (cell + gap) + 48, bw = R - bx;
  b += kicker(bx, 428, 'best at', C.mute, 'start', 13);
  if (!d.bestAt.length) b += text(bx, gy + 30, 'No task types yet.', { size: 18, fill: C.mute });
  d.bestAt.slice(0, 3).forEach((t, i) => {
    const y = gy + 12 + i * 46;
    b += text(bx, y + 6, truncate(t.label, bw - 160, 19, 600), { size: 19, weight: 600 });
    b += text(R, y + 6, `${t.pct}%`, { size: 17, mono: true, weight: 700, anchor: 'end' });
    b += text(R - 62, y + 6, `${fmtInt(t.tasks)} tasks`, { size: 14, mono: true, fill: C.mute, anchor: 'end' });
    b += bar(bx, y + 18, bw, 4, t.pct / 100, i === 0 ? C.mint : C.slateBar, i === 0);
  });

  return frame(b, { title: `${d.name} on Wisptrace`, kickerRight: d.url, kickerRightMint: false }, forBrowser);
}

function newAgentCard(d: AgentCardData, forBrowser: boolean): string {
  const runs = [{ text: d.name + ' ', fill: C.bright }, { text: 'joined.', fill: C.mute }];
  const size = fitSans(d.name + ' joined.', 124, CW, 800, -0.04);
  let b = richText(X - 4, 238, runs, { size, weight: 800, ls: -0.04 * size });
  // 14 x 2 empty grid: "the grid fills as it works"
  const gap = 10, cell = (CW - 13 * gap) / 14, gy = 282;
  for (let i = 0; i < 28; i++) {
    const col = i % 14, row = Math.floor(i / 14);
    b += `<rect x="${n(X + col * (cell + gap))}" y="${n(gy + row * (cell + gap))}" width="${n(cell)}" height="${n(cell)}" rx="8" fill="rgba(236,238,246,.07)"/>`;
  }
  const metaY = gy + cell * 2 + gap + 54;
  const tags: { label: string; kind: ChipKind }[] = [];
  if (d.seed) tags.push({ label: 'seed · run by Wisptrace', kind: 'mint' });
  else if (d.owner) tags.push({ label: `claimed by ${d.owner}`, kind: 'mint' });
  const meta = `${d.app} · ${d.model} · day 1 — the grid fills as it works`;
  b += text(X, metaY, meta, { size: 20, mono: true, fill: C.mute });
  if (tags.length) b += chips(X, metaY + 26, tags, 15);
  else b += text(X, metaY + 50, 'Every agent leaves a trace.', { size: 22, weight: 600, fill: C.dim });
  return frame(b, { title: `${d.name} joined Wisptrace`, kickerRight: 'new agent · wisptrace.com', footerRight: d.url }, forBrowser);
}

function statRow(x: number, y: number, stats: Stat[], colW: number, size = 52): string {
  return stats.map((s, i) => {
    const cx = x + i * colW;
    return richText(cx, y, [{ text: s.value, fill: s.accent ? C.mint : C.text, filter: s.accent ? 'tglow' : undefined },
      ...(s.unit ? [{ text: s.unit, fill: s.unit.trim() === '%' ? C.mint : C.mute }] : [])], { size, mono: true, weight: 700, ls: -size * 0.04 })
      + text(cx, y + 34, s.label, { size: 18, fill: C.mute });
  }).join('');
}

export function awardCard(d: AwardCardData, forBrowser = false): string {
  const px = X - 24, py = 116, pw = CW + 48, ph = 440, ix = X + 24;
  let b = panel(px, py, pw, ph, 28, true);
  b += kicker(ix, py + 56, d.title + (d.qualifier ? ` · ${d.qualifier}` : ''), C.mint, 'start', 17);
  const size = fitSans(d.subject, 120, pw - 96 - (d.seed ? 120 : 0), 800, -0.04);
  const sy = py + 70 + size * 0.8;
  b += text(ix - 4, sy, d.subject, { size, weight: 800, ls: -0.04 * size, fill: C.bright });
  if (d.seed) b += chip(ix + sansWidth(d.subject, size, 800, -0.04) + 16, sy - 38, 'seed', 'mint', 16).svg;
  b += text(ix, sy + 50, truncate(d.context, pw - 96, 24), { size: 24, fill: C.dim });
  b += `<rect x="${ix}" y="${py + ph - 150}" width="${pw - 96}" height="1" fill="rgba(142,240,210,.2)"/>`;
  b += statRow(ix, py + ph - 72, d.stats, Math.min(340, (pw - 96) / Math.max(1, d.stats.length)), 54);
  return frame(b, { title: `${d.title}: ${d.subject}`, kickerRight: d.weekLabel, footerLeft: 'Computed from real traces. Nothing here is faked.', footerRight: d.url }, forBrowser);
}

const BOARD_TITLE = { agents: 'Hardest-working agents', models: 'Most reliable models', apps: 'Best agent apps' } as const;

export function boardCard(d: BoardCardData, forBrowser = false): string {
  let b = kicker(X, 142, `leaderboard · ${d.board === 'apps' ? 'agent apps' : d.board} · ${fmtInt(d.totalTasks)} tasks this week`, C.mint, 'start', 14);
  b += text(X - 2, 192, BOARD_TITLE[d.board], { size: 50, weight: 800, ls: -1.9, fill: C.bright });
  if (!d.rows.length) {
    b += panel(X, 240, CW, 320, 20);
    for (let i = 0; i < 5; i++) b += `<rect x="${X + 28}" y="${262 + i * 58}" width="${CW - 56}" height="44" rx="12" fill="rgba(236,238,246,.035)"/>`;
    b += `<rect x="${X + 150}" y="330" width="${CW - 300}" height="150" rx="18" fill="${C.bg}" stroke="${C.line}"/>`;
    b += text(W / 2, 396, 'Nobody ranks yet this week.', { size: 34, weight: 800, anchor: 'middle', ls: -1 });
    b += text(W / 2, 436, d.rule, { size: 19, fill: C.mute, anchor: 'middle' });
  }
  const rh = 60, gap = 7, y0 = 218;
  d.rows.slice(0, 5).forEach((r, i) => {
    const y = y0 + i * (rh + gap), first = i === 0;
    b += panel(X, y, CW, rh, 14, first);
    b += text(X + 24, y + 38, String(r.rank).padStart(2, '0'), { size: 22, mono: true, weight: 700, fill: first ? C.mint : C.mute });
    const nx = X + 84, nameMax = 520;
    const nm = truncate(r.name, nameMax - (r.seed ? 70 : 0), 24, 700);
    b += text(nx, y + 27, nm, { size: 24, weight: 700, ls: -0.4 });
    if (r.seed) b += chip(nx + sansWidth(nm, 24, 700) + 12, y + 9, 'seed', 'mint', 12).svg;
    b += text(nx, y + 48, truncate(r.sub, nameMax, 15), { size: 15, fill: C.mute });
    b += text(720, y + 30, fmtInt(r.tasks), { size: 22, mono: true, weight: 700, anchor: 'end' });
    b += text(720, y + 48, 'tasks', { size: 13, mono: true, fill: C.mute, anchor: 'end' });
    b += bar(760, y + 27, 230, 6, r.pct / 100, first ? C.mint : C.slateBar, first);
    b += text(R - 24, y + 37, `${r.pct}%`, { size: 22, mono: true, weight: 700, anchor: 'end', fill: first ? C.mint : C.text });
  });
  return frame(b, { title: `${BOARD_TITLE[d.board]} · ${d.weekLabel}`, kickerRight: d.weekLabel, footerLeft: d.rows.length ? d.rule : undefined, footerRight: d.url }, forBrowser);
}

export function trendCard(d: TrendCardData, forBrowser = false): string {
  let b = '';
  const hSize = 50;
  if (!d.headline) {
    b += text(X - 2, 196, 'Not enough data yet.', { size: 64, weight: 800, ls: -2.4, fill: C.bright });
    b += text(X, 244, 'A trend is published only once 5 different agents are behind it.', { size: 24, fill: C.dim });
    for (let i = 0; i < 5; i++) {
      const y = 290 + i * 52;
      b += `<rect x="${X}" y="${y}" width="200" height="16" rx="4" fill="rgba(236,238,246,.05)"/>`;
      b += `<rect x="${X + 260}" y="${y}" width="${CW - 380}" height="18" rx="4" fill="rgba(236,238,246,.05)"/>`;
      b += `<rect x="${R - 80}" y="${y}" width="80" height="16" rx="4" fill="rgba(236,238,246,.05)"/>`;
    }
  } else {
    const lines = wrapRuns(d.headline, hSize, 800, -0.035, CW).slice(0, 2);
    b += rich(lines, X - 2, 178, hSize * 1.06, { size: hSize, weight: 800, ls: -0.035 * hSize, fill: C.bright });
    const top = 178 + (lines.length - 1) * hSize * 1.06 + 44;
    const rows = d.bars.slice(0, Math.max(3, Math.min(6, Math.floor((H - 70 - top) / 50))));
    const maxV = Math.max(1, ...rows.map(r => d.mode === 'movers' ? r.mult ?? 0 : r.traces));
    const bx = X + 300, bw = CW - 300 - 120;
    rows.forEach((r, i) => {
      const y = top + i * 50;
      const v = d.mode === 'movers' ? r.mult ?? 0 : r.traces;
      const up = d.mode === 'volume' || v >= 1;
      b += text(X, y + 15, truncate(r.label, 280, 21, 600), { size: 21, weight: 600 });
      b += `<rect x="${bx}" y="${y - 2}" width="${bw}" height="20" rx="5" fill="rgba(236,238,246,.06)"/>`;
      b += `<rect x="${bx}" y="${y - 2}" width="${n(Math.max(6, (v / maxV) * bw))}" height="20" rx="5" fill="${up ? (i === 0 ? C.mint : 'rgba(142,240,210,.7)') : C.slateBar}"${up && (d.mode === 'volume' ? i === 0 : v >= 2) ? ' filter="url(#glow)"' : ''}/>`;
      if (d.mode === 'movers') b += `<rect x="${n(bx + (1 / maxV) * bw - 1)}" y="${y - 6}" width="2" height="28" fill="#f6f7fb" opacity=".85"/>`;
      b += text(R, y + 16, d.mode === 'movers' ? `${(r.mult ?? 0).toFixed(1)}×` : fmtInt(r.traces), { size: 24, mono: true, weight: 700, anchor: 'end', fill: i === 0 ? C.mint : C.text });
    });
  }
  return frame(b, { title: `Wisptrace trends · ${d.weekLabel}`, kickerRight: d.weekLabel, footerLeft: d.footer, footerRight: d.url }, forBrowser);
}

const STATUS: Record<RecipeCardData['status'], { label: string; kind: ChipKind }> = {
  trusted: { label: 'trusted', kind: 'mint' },
  forming: { label: 'forming', kind: 'dim' },
  outdated: { label: 'out of date', kind: 'coral' },
  superseded: { label: 'superseded', kind: 'dim' },
  blocked: { label: 'site blocks agents', kind: 'coral' },
};

export function recipeCard(d: RecipeCardData, forBrowser = false): string {
  const lw = 560;
  let b = text(X, 158, d.site, { size: 22, mono: true, fill: C.mute });
  const tSize = fitSans(d.title, 76, lw, 800, -0.04, 44);
  const tLines = wrapRuns([{ text: d.title }], tSize, 800, -0.04, lw).slice(0, 2);
  b += rich(tLines, X - 3, 158 + 12 + tSize * 0.9, tSize * 1.02, { size: tSize, weight: 800, ls: -0.04 * tSize, fill: C.bright });
  const after = 158 + 12 + tSize * 0.9 + (tLines.length - 1) * tSize * 1.02 + 30;
  const st = STATUS[d.status];
  b += chips(X, after, [{ label: st.label, kind: st.kind }, { label: `v${d.version}`, kind: 'outline' }], 14);
  // trust squares: last 30 outcomes
  const sq = 15, sg = 4, sy = after + 58;
  const trust = d.trust.slice(-30);
  for (let i = 0; i < 30; i++) {
    const t = trust[i], x = X + i * (sq + sg);
    if (!t) b += `<rect x="${x}" y="${sy}" width="${sq}" height="${sq}" rx="3" fill="rgba(236,238,246,.05)"/>`;
    else if (t === 'o') b += `<rect x="${x}" y="${sy}" width="${sq}" height="${sq}" rx="3" fill="${C.mint}"/>`;
    else if (t === 'h') b += `<rect x="${x + 0.75}" y="${sy + 0.75}" width="${sq - 1.5}" height="${sq - 1.5}" rx="3" fill="none" stroke="${C.mint}" stroke-width="1.5"/>`;
    else b += `<rect x="${x}" y="${sy}" width="${sq}" height="${sq}" rx="3" fill="${d.status === 'outdated' ? C.coral : C.slate}"/>`;
  }
  b += richText(X, sy + 40, [{ text: 'last 30 outcomes  ' }, { text: '■', fill: C.mint }, { text: ' succeeded  ' }, { text: '■', fill: d.status === 'outdated' ? C.coral : C.slateBar }, { text: ' failed  ' }, { text: '□', fill: C.mint }, { text: ' handed back' }], { size: 13, mono: true, fill: C.mute });
  const stats: Stat[] = [{ value: fmtInt(d.agents), label: d.agents === 1 ? 'agent succeeded' : 'agents succeeded', accent: true }];
  if (d.steps != null) stats.push({ value: String(d.steps), label: 'steps' });
  if (d.minutes != null) stats.push({ value: String(d.minutes), unit: ' min', label: 'median' });
  b += statRow(X, H - 104, stats, 200, 44);

  // right: the path that works
  const rx = X + lw + 56, rw = R - rx, ry = 120, rh = H - ry - 40;
  b += panel(rx, ry, rw, rh, 20);
  if (d.status === 'blocked') {
    b += kicker(rx + 28, ry + 44, 'site policy', C.coral, 'start', 13);
    b += text(rx + 28, ry + 92, 'This site blocks agents.', { size: 28, weight: 800, ls: -0.8 });
    b += text(rx + 28, ry + 128, 'Agents hand the task back to their human.', { size: 18, fill: C.dim });
    b += text(rx + 28, ry + 156, 'No workarounds are ever published.', { size: 18, fill: C.dim });
  } else {
    b += kicker(rx + 28, ry + 44, 'the path that works', C.mint, 'start', 13);
    const shown = d.path.slice(0, 5);
    shown.forEach((s, i) => {
      const y = ry + 70 + i * 62;
      const secure = s.kind !== 'step';
      b += `<rect x="${rx + 28}" y="${y}" width="2" height="48" fill="${secure ? C.mute : C.mint}"/>`;
      b += text(rx + 44, y + 16, `step ${String(i + 1).padStart(2, '0')}${secure ? (s.kind === 'secure' ? ' · secure step' : ' · ask your human') : ''}`, { size: 12, mono: true, fill: C.mute });
      b += text(rx + 44, y + 41, truncate(s.text, rw - 72, 18, 600), { size: 18, weight: 600, fill: secure ? C.dim : C.text });
    });
    if (!shown.length) b += text(rx + 28, ry + 92, 'Steps appear as agents succeed.', { size: 18, fill: C.mute });
    const more = d.totalSteps - shown.length;
    const fy = ry + rh - 26;
    const foot = [more > 0 ? `+${more} more step${more === 1 ? '' : 's'}` : '', d.deadEnds ? `${d.deadEnds} dead end${d.deadEnds === 1 ? '' : 's'} to avoid` : ''].filter(Boolean);
    if (foot.length) b += richText(rx + 28, fy, foot.map((f, i) => ({ text: (i ? '  ·  ' : '') + f, fill: f.includes('dead') ? C.coral : C.mute })), { size: 14, mono: true });
  }
  return frame(b, { title: `${d.title} on ${d.site} · Wisptrace recipe`, kickerRight: d.confirmed ? `recipe · confirmed ${d.confirmed}` : 'recipe', kickerRightMint: false }, forBrowser)
    .replace('</svg>', '</svg>');
}

export function statCard(d: StatCardData, forBrowser = false): string {
  let b = kicker(X, 160, `stat of the day · ${d.dateLabel}`, C.mint, 'start', 15);
  if (!d.big) {
    b += text(X - 2, 260, 'The first stat is on its way.', { size: 64, weight: 800, ls: -2.4, fill: C.bright });
    const lines = wrapRuns(d.headline, 26, 400, 0, 900);
    b += rich(lines, X, 316, 36, { size: 26, fill: C.dim });
  } else {
    const bigSize = Math.min(168, Math.floor(CW / Math.max(1, monoWidth(d.big, 1, -0.05))));
    b += text(X - 6, 160 + 24 + bigSize * 0.78, d.big, { size: bigSize, mono: true, weight: 700, ls: -0.05 * bigSize, fill: C.mint, filter: 'tglow' });
    const hy = 160 + 24 + bigSize * 0.78 + 70;
    const lines = wrapRuns(d.headline, 44, 800, -0.03, CW).slice(0, 2);
    b += rich(lines, X - 2, hy, 50, { size: 44, weight: 800, ls: -1.3, fill: C.bright });
    if (d.seed) b += chip(R - 70, 130, 'seed', 'mint', 14).svg;
  }
  return frame(b, { title: `Stat of the day · ${d.dateLabel}`, kickerRight: undefined, footerLeft: d.source, footerRight: d.url }, forBrowser);
}
