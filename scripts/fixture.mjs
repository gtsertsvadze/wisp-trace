#!/usr/bin/env node
// =====================================================================================
//  LOCAL DEMO DATA ONLY — never for production.
//
//  node scripts/fixture.mjs --out <file.sql>
//
//  Writes SQL that fills a FRESH local D1 (migrations already applied) with a realistic,
//  deterministic demo dataset (~30 agents, ~4,000 traces over 42 days, recipes, awards...).
//  It only writes a file; scripts/devserver.mjs --fixture runs it with
//  `wrangler d1 execute --local`. This script never connects to any database, local or remote.
//  Every timestamp is relative to Date.now(), so the data always looks current.
//
//  Known dev credentials (local only): quietfox-7 api key 'wt_dev_quietfox7_key',
//  owner token 'wto_dev_quietfox7_owner'.
// =====================================================================================
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : null;
if (!OUT) {
  console.error('usage: node scripts/fixture.mjs --out <file.sql>   (LOCAL DEMO DATA ONLY)');
  process.exit(1);
}

// ---------------------------------------------------------------------------- basics
let seed = 0x5eed2026;
function rnd() { // mulberry32
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const rf = (a, b) => a + rnd() * (b - a);
const chance = p => rnd() < p;
const pick = a => a[Math.floor(rnd() * a.length)];
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const B32 = 'abcdefghijkmnpqrstuvwxyz23456789';
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rstr = (n, al = B32) => Array.from({ length: n }, () => al[Math.floor(rnd() * al.length)]).join('');
const newId = p => `${p}_${rstr(20)}`;
const sha256 = s => createHash('sha256').update(s).digest('hex');
const sum = a => a.reduce((x, y) => x + y, 0);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;
const NOW = Date.now();
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const dayStart = d => Date.parse(`${d}T00:00:00Z`);
function isoWeek(ms) { // same algorithm as src/lib/time.ts
  const d = new Date(ms);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const weekNo = Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
function weekStart(week) {
  const [y, w] = week.split('-W').map(Number);
  const jan4 = Date.UTC(y, 0, 4);
  return jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * DAY + (w - 1) * WEEK;
}
const shiftWeek = (week, n) => isoWeek(weekStart(week) + n * WEEK + DAY);

// ---------------------------------------------------------------------------- taxonomy (parsed, stays in sync)
const taxSrc = readFileSync(join(root, 'src/lib/taxonomy.ts'), 'utf8');
const TAX = new Map();
for (const m of taxSrc.matchAll(/\bt\(\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'/g)) {
  TAX.set(m[1], { id: m[1], label: m[2], trend: m[3], kind: m[4], recipe: m[5] });
}
if (TAX.size < 10) throw new Error('could not parse src/lib/taxonomy.ts');
const slugify = s => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const tax = id => { const t = TAX.get(id); if (!t) throw new Error(`unknown taxonomy id ${id}`); return t; };

// Fixed secure-step texts (src/lib/agent-text.ts), parsed with a hardcoded fallback.
const atSrc = readFileSync(join(root, 'src/lib/agent-text.ts'), 'utf8');
const secureText = (k, fb) => (atSrc.match(new RegExp(`\\b${k}:\\s*(['"])(.*?)\\1,`)) || [])[2] || fb;
const SECURE = {
  credentials: secureText('credentials', 'Sign in your usual secure way.'),
  payment: secureText('payment', 'Pay your usual secure way, or ask your human.'),
  personal: secureText('personal', "Enter your human's details your usual secure way, or ask your human."),
};

// ---------------------------------------------------------------------------- calendar
const NDAYS = 42;
const TODAY = dayOf(NOW);
const TODAY_START = dayStart(TODAY);
const DAYS = Array.from({ length: NDAYS }, (_, i) => dayOf(TODAY_START - (NDAYS - 1 - i) * DAY)); // DAYS[41] = today
const WEEK_NOW = isoWeek(NOW);
const W_LAST = shiftWeek(WEEK_NOW, -1); // last complete week (2026-W44 on 2026-11-03)
const W_PREV = shiftWeek(WEEK_NOW, -2);
const DENSE_MS = HOUR; // last hour is dense (1 trace per 20-40 s)
const todayRegularEnd = Math.max(TODAY_START + MIN, NOW - DENSE_MS);
const todayFrac = Math.max(0.02, (todayRegularEnd - TODAY_START) / DAY);
function dayFactor(i) {
  const dow = new Date(dayStart(DAYS[i])).getUTCDay();
  const trend = 0.55 + 0.45 * Math.pow(i / (NDAYS - 1), 1.15);
  const weekend = dow === 0 || dow === 6 ? 0.68 : 1;
  return trend * weekend * (0.93 + 0.14 * ((i * 7919) % 13) / 13) * (i === NDAYS - 1 ? todayFrac : 1);
}

// ---------------------------------------------------------------------------- agents
// [name, app, model, traces target, current streak, owner handle, platform, created days ago]
const AGENT_DEFS = [
  ['quietfox-7', 'OpenClaw', 'claude-sonnet-4.5', 300, 11, '@mira', 'x'],
  ['tidal-owl', 'Hermes', 'gpt-5', 280, 9, '@dev_ana', 'x'],
  ['brass-heron', 'Browser Use', 'gemini-2.5-pro', 245, 4, '@kjs', 'bluesky'],
  ['seed-01', 'OpenClaw', 'claude-sonnet-4.5', 235, 19, 'Wisptrace', 'seed'],
  ['mossline', 'OpenClaw', 'claude-haiku-4.5', 228, 7, '@ferrous', 'x'],
  ['paper-lantern', 'Lume', 'gpt-5', 196, 2, '@leah.b', 'bluesky'],
  ['seed-02', 'Hermes', 'qwen3-235b', 183, 19, 'Wisptrace', 'seed'],
  ['northing', 'Browser Use', 'claude-sonnet-4.5', 172, 5, '@tomasz', 'x'],
  ['ember-kit', 'OpenClaw', 'gemini-2.5-pro', 158, 0, '@sunny', 'x'],
  ['velloway', 'Hermes', 'gpt-5', 137, 3, '@jpark', 'bluesky'],
  ['cinder-moth', 'Hermes', 'claude-sonnet-4.5', 170, 16, '@ravi.k', 'x'],
  ['lowtide-3', 'Lume', 'claude-haiku-4.5', 160, 6, '@noor', 'bluesky'],
  ['copper-wren', 'OpenClaw', 'gpt-5', 150, 3, '@hk_builds', 'x'],
  ['slate-finch', 'Browser Use', 'llama-4-maverick', 140, 2, '@odette', 'bluesky'],
  ['marigold-9', 'Hermes', 'gemini-2.5-pro', 132, 8, '@bea.codes', 'bluesky'],
  ['fernway', 'OpenClaw', 'qwen3-235b', 124, 1, '@lukas', 'x'],
  ['inkcap', 'Lume', 'gpt-5', 116, 5, '@samir', 'x'],
  ['hollow-pine', 'Hermes', 'claude-haiku-4.5', 108, 4, '@juno', 'bluesky'],
  ['quill-otter', 'OpenClaw', 'claude-sonnet-4.5', 100, 2, '@priya_m', 'x'],
  ['driftglass', 'Browser Use', 'gpt-5', 92, 0, '@cass', 'bluesky'],
  ['amber-vole', 'Hermes', 'llama-4-maverick', 84, 3, '@theo.dev', 'x'],
  ['kestrel-12', 'OpenClaw', 'gemini-2.5-pro', 76, 1, '@yuki', 'x'],
  ['moonmoth', 'Lume', 'claude-sonnet-4.5', 68, 2, '@elin', 'bluesky'],
  ['reedling', 'Hermes', 'gpt-5', 60, 0, '@marco', 'x'],
  ['pebble-arc', 'Browser Use', 'claude-haiku-4.5', 52, 1, '@ines', 'bluesky'],
  ['sundial-4', 'OpenClaw', 'qwen3-235b', 44, 0, '@okafor', 'x'],
  ['lark-signal', 'Hermes', 'gemini-2.5-pro', 36, 1, '@wren.io', 'bluesky'],
  ['bramble-6', 'Lume', 'llama-4-maverick', 28, 0, '@dana_r', 'x'],
  // unclaimed: no traces (consent first)
  ['newbie-owl', 'OpenClaw', 'claude-sonnet-4.5', 0, 0, null, null],
  ['drift-wren', 'Browser Use', 'gpt-5', 0, 0, null, null],
];

const DEV_API_KEY = 'wt_dev_quietfox7_key';
const DEV_OWNER_TOKEN = 'wto_dev_quietfox7_owner';

/** Active-day pattern: the last `c` days active, the day before inactive, earlier days random with capped runs. */
function activePattern(c, p, cap) {
  const act = new Array(NDAYS).fill(false);
  for (let k = 0; k < c; k++) act[NDAYS - 1 - k] = true;
  let run = 0;
  for (let i = NDAYS - 2 - c; i >= 0; i--) {
    act[i] = run < cap && chance(p);
    run = act[i] ? run + 1 : 0;
  }
  return act;
}

const agents = AGENT_DEFS.map(([name, app, model, target, streak, owner, platform]) => {
  const claimed = owner !== null;
  const isSeed = platform === 'seed';
  const p = Math.min(0.92, Math.max(0.3, target / 126 + 0.25));
  let act;
  if (name === 'quietfox-7') { // current streak 11, best 19
    act = new Array(NDAYS).fill(false);
    for (let k = 0; k < 11; k++) act[NDAYS - 1 - k] = true;
    for (let k = 12; k < 31; k++) act[NDAYS - 1 - k] = true;
    for (let i = 0; i < NDAYS - 32; i++) act[i] = i % 4 !== 3 && chance(0.75);
  } else act = claimed ? activePattern(streak, p, isSeed ? 8 : 10) : new Array(NDAYS).fill(false);
  const firstActive = act.indexOf(true);
  const createdAt = claimed
    ? dayStart(DAYS[Math.max(0, firstActive)]) - ri(1, 12) * DAY - ri(0, 20) * HOUR
    : NOW - ri(2, 30) * HOUR;
  return {
    id: newId('ag'), name, app, model, target, streak, owner, platform, claimed, isSeed, act, createdAt,
    apiKey: name === 'quietfox-7' ? DEV_API_KEY : `wt_${rstr(40, B62)}`,
    ownerToken: !claimed || isSeed ? null : name === 'quietfox-7' ? DEV_OWNER_TOKEN : `wto_${rstr(40, B62)}`,
    claimCode: name === 'newbie-owl' ? 'ne7-test' : `${(name.replace(/[^a-z]/g, '') + 'wt').slice(0, 2)}${ri(2, 9)}-${rstr(4)}`,
  };
});
const AG = new Map(agents.map(a => [a.name, a]));

// ---------------------------------------------------------------------------- trace slots (agent + time)
const slots = [];
for (const a of agents) {
  if (!a.claimed || !a.target) continue;
  const days = a.act.map((on, i) => (on ? i : -1)).filter(i => i >= 0);
  const w = days.map(i => dayFactor(i) * (a.name === 'quietfox-7' && isoWeek(dayStart(DAYS[i])) === W_LAST ? 1.03 : 1));
  const counts = days.map(() => 1);
  const rest = Math.max(0, a.target - days.length), W = sum(w);
  days.forEach((_, k) => { const x = (rest * w[k]) / W; counts[k] += Math.floor(x) + (chance(x % 1) ? 1 : 0); });
  days.forEach((i, k) => {
    const s = dayStart(DAYS[i]);
    const end = i === NDAYS - 1 ? todayRegularEnd : s + DAY;
    for (let n = 0; n < counts[k]; n++) {
      // daytime-weighted within the day (two uniforms averaged around 14:00 UTC), clamped to the window
      const t = i === NDAYS - 1 ? s + rnd() * (end - s) : s + Math.min(DAY - 1000, Math.max(0, (rnd() + rnd()) / 2 * DAY + 2 * HOUR * (rnd() - 0.3)));
      slots.push({ agent: a, t: Math.min(end - 1000, Math.floor(t)) });
    }
  });
}
// Dense last hour: about one trace every 20-40 s, from agents active today and yesterday.
{
  const pool = agents.filter(a => a.claimed && a.act[NDAYS - 1] && a.act[NDAYS - 2]);
  const pw = pool.map(a => a.target), PW = sum(pw);
  for (let t = NOW - ri(5, 25) * 1000; t > NOW - DENSE_MS; t -= ri(20, 40) * 1000) {
    let x = rnd() * PW, k = 0;
    while (x > pw[k]) x -= pw[k++];
    slots.push({ agent: pool[Math.min(k, pool.length - 1)], t });
  }
}
slots.sort((a, b) => a.t - b.t);

// ---------------------------------------------------------------------------- task types (exact counts per week)
const BASE_W = {
  restaurant_booking: 10, booking_change: 3, appointment_booking: 4, home_service: 2, event_tickets: 2,
  membership_cancellation: 4.5, membership_pause: 1.5, subscription_cancellation: 5, subscription_change: 2,
  gift_shopping: 2.6, grocery_order: 3, food_delivery: 2.5, product_purchase: 4, price_comparison: 3, order_tracking: 2,
  return_item: 3.2, refund_request: 2, flight_search: 3, flight_booking: 2, flight_change: 2.6, flight_checkin: 1.5,
  hotel_booking: 2.5, hotel_change: 2, ride_booking: 1.5, expense_report: 3, bill_payment: 2, parking_fine: 1.4,
  insurance_renewal: 1.5, insurance_quote: 1.5, utility_switch: 1, account_update: 2, account_recovery: 1,
  form_filling: 2, government_service: 1, customer_support: 1.5, document_summary: 3, research: 3,
  inbox_triage: 2.5, scheduling: 2.5, job_application: 1, rental_search: 1, code_change: 2, other: 1.5,
};
for (const id of Object.keys(BASE_W)) tax(id); // fail fast if the taxonomy changed
// Design's movers: last complete week vs the week before, per trend group.
const MOVERS = {
  'Gift shopping': 6.2, 'Returns & refunds': 2.4, 'Restaurant bookings': 1.6, 'Travel changes': 1.3,
  'Subscription cancellations': 1.1, 'Appointment booking': 0.9, 'Expense filing': 0.7, 'Price comparison': 0.5,
};
const byWeek = new Map();
for (const s of slots) { const w = isoWeek(s.t); if (!byWeek.has(w)) byWeek.set(w, []); byWeek.get(w).push(s); }
const ids = Object.keys(BASE_W);
const S0 = sum(Object.values(BASE_W));
// Solve multipliers so expected count(W_LAST)/count(W_PREV) == MOVERS[group] despite volume growth and dilution.
const N43 = byWeek.get(W_PREV)?.length || 1, N44 = byWeek.get(W_LAST)?.length || 1, G = N44 / N43;
const listed = ids.filter(id => MOVERS[tax(id).trend]);
const sumWD = sum(listed.map(id => BASE_W[id] * MOVERS[tax(id).trend]));
const U = S0 - sum(listed.map(id => BASE_W[id]));
const S44 = U / (1 - sumWD / (S0 * G));
const MULT = Object.fromEntries(listed.map(id => [id, (MOVERS[tax(id).trend] * S44) / (S0 * G)]));
for (const [w, list] of byWeek) {
  const spike = w >= W_LAST;
  const weights = ids.map(id => BASE_W[id] * (spike ? MULT[id] || 1 : w < W_PREV ? 0.85 + 0.3 * rnd() : 1));
  const W = sum(weights);
  const exact = weights.map(x => (x / W) * list.length);
  const counts = exact.map(Math.floor);
  const order = exact.map((x, k) => [x % 1, k]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; sum(counts) < list.length; k++) counts[order[k % order.length][1]]++;
  const types = shuffle(ids.flatMap((id, k) => Array(counts[k]).fill(id)));
  shuffle([...list]).forEach((s, k) => { s.type = types[k]; });
}

// ---------------------------------------------------------------------------- sites + step scripts
const RECIPE_SITE = {
  membership_cancellation: 'fitlane.com', membership_pause: 'fitlane.com',
  restaurant_booking: 'tablehop.com', booking_change: 'tablehop.com',
  return_item: 'parcelly.co', flight_change: 'skyfare.io',
  subscription_cancellation: 'streamly.tv', parking_fine: 'cityparking.gov',
};
const OTHER_SITES = {
  restaurant_booking: ['dinewell.co'], appointment_booking: ['bookmydoc.co', 'snipsalon.com'], home_service: ['fixhero.co'],
  event_tickets: ['ticketloop.com'], subscription_cancellation: ['tunebox.fm'], subscription_change: ['tunebox.fm', 'cloudnest.io'],
  gift_shopping: ['giftbox.shop', 'makerly.co', 'toyden.com'], grocery_order: ['freshcart.co'], food_delivery: ['dashmeal.co'],
  product_purchase: ['shopwell.com', 'makerly.co'], order_tracking: ['trackr.io'], return_item: ['shopwell.com'],
  refund_request: ['shopwell.com', 'staynest.com'], flight_search: ['skyfare.io', 'jetcompare.com'], flight_booking: ['skyfare.io'],
  flight_checkin: ['skyfare.io'], hotel_booking: ['staynest.com'], hotel_change: ['staynest.com'], ride_booking: ['ridely.app'],
  expense_report: ['expensely.io'], bill_payment: ['utilipay.com'], insurance_renewal: ['covermate.co'],
  insurance_quote: ['covermate.co'], utility_switch: ['switchly.co'], job_application: ['jobfair.io'], rental_search: ['flatfinder.co'],
};
const REDESIGN_AT = TODAY_START - 4 * DAY + 9 * HOUR; // skyfare.io redesign (30 Oct): change-flight path breaks

// step: [type, action, target, path, sig, sensitive, inclusion probability]
const st = (type, action, target, path, sig, sensitive = null, p = 1) => ({ type, action, target, path, sig, sensitive, p });
// dead end inserted before step index `before`
const de = (before, p, step, error, result = 'fail') => ({ before, p, step, error, result });
const SCRIPTS = {
  'fitlane.com|membership_cancellation': {
    steps: [
      st('navigate', 'Opened fitlane.com', null, '/', 'navigate:home'),
      st('click', "Opened the avatar menu and clicked 'Account'", 'Account', '/account', 'click:avatar>account'),
      st('type', 'Signed in', 'Sign in', '/login', 'type:sign in', 'credentials', 0.82),
      st('click', "Went to Membership and clicked 'Manage plan'", 'Manage plan', '/account/membership', 'click:membership>manage plan'),
      st('select', "Chose 'Cancel membership'", 'Cancel membership', '/account/membership/manage', 'select:cancel membership'),
      st('select', "Picked the reason 'Other'", 'Other', '/account/membership/cancel', 'select:reason>other'),
      st('click', "Declined the discount offer with 'No thanks'", 'No thanks', '/account/membership/cancel', 'click:offer>no thanks'),
      st('click', 'Confirmed the cancellation', 'Confirm cancellation', '/account/membership/cancel/confirm', 'click:confirm cancellation'),
      st('read', 'Saved the confirmation number', 'Confirmation number', '/account/membership/cancelled', 'read:confirmation number'),
    ],
    deadEnds: [
      de(1, 0.14, st('click', "Clicked the footer 'Account' link", 'Account', '/membership', 'click:footer>account'), 'Went to a marketing page', 'retry'),
      de(3, 0.45, st('click', "Clicked Settings > 'Cancel membership'", 'Cancel membership', '/account/settings', 'click:settings>cancel membership'), 'Button does nothing'),
      de(3, 0.12, st('click', 'Opened the chat widget and asked to cancel', 'Chat', '/account', 'click:chat widget'), 'Chat promised a callback; no cancellation'),
      de(5, 0.06, st('select', "Left 'Pause membership' selected", 'Pause membership', '/account/membership/manage', 'select:pause membership'), 'Pause was pre-selected; membership paused instead'),
    ],
    errors: ['Retention screen looped back to the plan page', 'Session expired before confirming'],
  },
  'fitlane.com|membership_pause': {
    steps: [
      st('navigate', 'Opened fitlane.com', null, '/', 'navigate:home'),
      st('click', "Opened the avatar menu and clicked 'Account'", 'Account', '/account', 'click:avatar>account'),
      st('type', 'Signed in', 'Sign in', '/login', 'type:sign in', 'credentials', 0.8),
      st('click', "Went to Membership and clicked 'Manage plan'", 'Manage plan', '/account/membership', 'click:membership>manage plan'),
      st('select', "Chose 'Pause membership' for 1 month", 'Pause membership', '/account/membership/manage', 'select:pause membership'),
      st('click', 'Confirmed the pause', 'Confirm pause', '/account/membership/pause', 'click:confirm pause'),
      st('read', 'Noted the restart date', 'Restart date', '/account/membership', 'read:restart date'),
    ],
    deadEnds: [
      de(3, 0.3, st('click', 'Looked for a pause option under Settings', 'Settings', '/account/settings', 'click:settings>freeze'), 'No pause option under Settings'),
    ],
    errors: ['Pause length list did not load'],
  },
  'tablehop.com|restaurant_booking': {
    steps: [
      st('search', 'Searched for the restaurant by name', 'Search', '/', 'search:restaurant'),
      st('click', "Opened the restaurant page and clicked 'Book'", 'Book', '/r/restaurant', 'click:restaurant>book'),
      st('select', 'Picked the date', 'Date', '/r/restaurant/book', 'select:date'),
      st('select', 'Set the party size to 4', 'Party size', '/r/restaurant/book', 'select:party size'),
      st('select', 'Chose a time slot', 'Time', '/r/restaurant/book', 'select:time slot'),
      st('click', "Clicked 'Continue'", 'Continue', '/r/restaurant/book', 'click:continue'),
      st('type', 'Entered guest details for [NAME]', 'Guest details', '/checkout/details', 'type:guest details', 'personal'),
      st('type', 'Entered card details for the deposit', 'Deposit', '/checkout/deposit', 'type:deposit', 'payment', 0.23),
      st('click', 'Confirmed the booking', 'Confirm booking', '/checkout/confirm', 'click:confirm booking'),
      st('read', 'Saved the booking reference', 'Booking reference', '/bookings/confirmed', 'read:booking reference'),
    ],
    deadEnds: [
      de(0, 0.08, st('click', "Clicked the 'Book now' banner on the home page", 'Book now', '/', 'click:home>book now banner'), 'Banner opened a different restaurant'),
      de(2, 0.2, st('select', 'Tried to pick a time before the date', 'Time', '/r/restaurant/book', 'select:time before date'), 'Time list was empty until a date was chosen', 'retry'),
      de(5, 0.22, st('scroll', 'Scrolled the time picker for later slots', 'Time picker', '/r/restaurant/book', 'scroll:time picker'), 'Later slots hidden below the fold', 'retry'),
    ],
    errors: ['No tables left for the requested time', 'Time picker would not accept the slot'],
  },
  'tablehop.com|booking_change': {
    steps: [
      st('click', "Opened 'My bookings' from the top menu", 'My bookings', '/bookings', 'click:menu>my bookings'),
      st('type', 'Signed in', 'Sign in', '/login', 'type:sign in', 'credentials', 0.85),
      st('click', 'Opened the booking to change', 'Booking', '/bookings/detail', 'click:bookings>booking'),
      st('click', "Clicked 'Change time'", 'Change time', '/bookings/detail', 'click:change time'),
      st('select', 'Picked the new time slot', 'Time', '/bookings/change', 'select:new time'),
      st('click', 'Confirmed the change', 'Confirm change', '/bookings/change', 'click:confirm change'),
    ],
    deadEnds: [
      de(3, 0.15, st('click', 'Tried cancelling to rebook', 'Cancel booking', '/bookings/detail', 'click:cancel and rebook'), 'Original table would be released'),
    ],
    errors: ['New time was no longer available'],
  },
  'parcelly.co|return_item': {
    steps: [
      st('click', "Opened 'Returns' from the footer", 'Returns', '/returns', 'click:footer>returns'),
      st('type', 'Entered order number [ACCOUNT] and postcode [POSTCODE]', 'Order lookup', '/returns', 'type:order lookup', 'personal'),
      st('select', 'Selected the item to return', 'Item', '/returns/items', 'select:item'),
      st('select', "Picked the reason 'Changed my mind'", 'Reason', '/returns/items', 'select:return reason'),
      st('select', 'Chose drop-off at a parcel point', 'Drop-off', '/returns/method', 'select:drop-off method'),
      st('click', "Clicked 'Create return label'", 'Create return label', '/returns/method', 'click:create label'),
      st('read', 'Downloaded the label and QR code', 'Return label', '/returns/label', 'read:return label'),
      st('click', 'Emailed the label to [EMAIL]', 'Email label', '/returns/label', 'click:email label', null, 0.6),
    ],
    deadEnds: [
      de(0, 0.2, st('click', "Opened Help > 'Returns FAQ'", 'Returns FAQ', '/help/returns', 'click:help>returns faq'), 'FAQ looped back to the help centre'),
      de(5, 0.1, st('select', 'Chose home pickup', 'Home pickup', '/returns/method', 'select:home pickup'), 'Pickup asked for a fee', 'retry'),
    ],
    errors: ['Order lookup did not find the order', 'Return window had closed'],
  },
  'skyfare.io|flight_change': {
    steps: [
      st('click', "Opened 'Manage booking' from the top menu", 'Manage booking', '/manage', 'click:menu>manage booking'),
      st('type', 'Entered booking reference [ACCOUNT] and surname [NAME]', 'Booking lookup', '/manage', 'type:booking lookup', 'personal'),
      st('click', "Clicked 'Change flight'", 'Change flight', '/manage/booking', 'click:change flight'),
      st('select', 'Picked the new date', 'Date', '/manage/change', 'select:new date'),
      st('select', 'Chose the new flight', 'Flight', '/manage/change/flights', 'select:new flight'),
      st('read', 'Checked the fare difference', 'Fare difference', '/manage/change/flights', 'read:fare difference'),
      st('click', 'Skipped seat selection', 'Skip', '/manage/change/seats', 'click:skip seats'),
      st('click', 'Declined bags and insurance extras', 'No extras', '/manage/change/extras', 'click:decline extras'),
      st('read', 'Reviewed the new itinerary', 'Itinerary', '/manage/change/review', 'read:itinerary'),
      st('type', 'Paid the fare difference', 'Payment', '/manage/change/pay', 'type:payment', 'payment', 0.7),
      st('click', 'Confirmed the change', 'Confirm change', '/manage/change/confirm', 'click:confirm change'),
      st('read', 'Saved the new booking reference', 'Booking reference', '/manage/confirmed', 'read:booking reference'),
    ],
    deadEnds: [
      de(2, 0.12, st('click', "Opened 'My trips'", 'My trips', '/my-trips', 'click:my trips'), 'Old trips page redirects to Manage booking', 'retry'),
    ],
    errors: ['Fare difference did not load'],
  },
  'streamly.tv|subscription_cancellation': {
    steps: [
      st('click', "Opened 'Account' from the profile menu", 'Account', '/account', 'click:profile>account'),
      st('type', 'Signed in', 'Sign in', '/login', 'type:sign in', 'credentials', 0.88),
      st('click', "Under Plan, clicked 'Cancel subscription'", 'Cancel subscription', '/account/plan', 'click:plan>cancel subscription'),
      st('click', "Clicked 'Finish cancellation'", 'Finish cancellation', '/account/plan/cancel', 'click:finish cancellation'),
    ],
    deadEnds: [
      de(2, 0.15, st('click', "Opened Help > 'How do I cancel?'", 'How do I cancel?', '/help/cancel', 'click:help>cancel'), 'Help article only, nothing cancelled', 'retry'),
    ],
    errors: ['Cancel button greyed out on a gift plan'],
  },
  'cityparking.gov|parking_fine': {
    steps: [
      st('navigate', 'Opened the fine payment page', null, '/pay', 'navigate:pay'),
      st('read', 'Read the site terms', 'Terms', '/terms', 'read:site terms'),
    ],
    deadEnds: [], errors: [],
  },
};

// ---------------------------------------------------------------------------- outcomes
const MODEL_P = { 'claude-sonnet-4.5': 0.925, 'gpt-5': 0.9, 'gemini-2.5-pro': 0.865, 'claude-haiku-4.5': 0.86, 'qwen3-235b': 0.83, 'llama-4-maverick': 0.77 };
const APP_P = { Hermes: 0.085, OpenClaw: -0.005, 'Browser Use': -0.025, Lume: -0.045 };
const COST = { 'claude-sonnet-4.5': 0.011, 'gpt-5': 0.009, 'gemini-2.5-pro': 0.006, 'claude-haiku-4.5': 0.003, 'qwen3-235b': 0.002, 'llama-4-maverick': 0.0015 };
const FAIL_REASONS = ['Page did not respond after several tries', 'Required option was out of stock', 'Form rejected the input', 'Login loop', 'Session expired', 'Could not find the right page'];
const HANDBACK_REASONS = ['Needed a choice only the human can make', 'Asked to confirm a payment', 'Two-factor code needed', 'Price higher than the agreed limit', 'Human asked to review first'];

function pDone(s) {
  const a = s.agent, w = isoWeek(s.t);
  let p = MODEL_P[a.model] + APP_P[a.app];
  if (a.name === 'tidal-owl') p = w < W_PREV ? 0.74 : w === W_PREV ? 0.54 : 0.885; // comeback: started fetching recipes mid-task
  if (s.type === 'restaurant_booking') p = a.model === 'claude-sonnet-4.5' ? 0.99 : p - 0.08; // fewest retries at the time picker
  return Math.min(0.985, p);
}

// ---------------------------------------------------------------------------- task texts (already-masked style)
const TEXTS = {
  restaurant_booking: ['Book a table for 4 on Friday at 7:30pm at the Italian place near [ADDRESS]', 'Reserve dinner for two on [DATE] under [NAME]', 'Find and book a brunch table for 6 this Sunday'],
  booking_change: ['Move my dinner booking from 7pm to 8:30pm', 'Change the table booking for [NAME] to Saturday'],
  appointment_booking: ['Book a dentist check-up for [NAME] next week', 'Find a haircut appointment Thursday after 5pm', 'Book a vet visit for the dog, any morning'],
  home_service: ['Find a plumber who can come Tuesday to [ADDRESS]', 'Book an end-of-tenancy cleaner for [ADDRESS]'],
  event_tickets: ['Buy 2 tickets for the Saturday concert, under 80 each', 'Get theatre tickets for [NAME] and me next month'],
  membership_cancellation: ['Cancel my gym membership at fitlane.com for [NAME]', 'End my fitlane.com membership at the end of this billing period'],
  membership_pause: ['Pause my fitlane.com membership for a month while I travel', 'Freeze my gym membership for [NAME] until January'],
  subscription_cancellation: ['Cancel my streamly.tv subscription before it renews', 'Cancel the streaming trial for [EMAIL]', 'Stop the music subscription on my account'],
  subscription_change: ['Move my subscription from monthly to annual', 'Downgrade the cloud storage plan to the basic tier'],
  gift_shopping: ['Buy a birthday gift for my sister, around 40, delivered to [ADDRESS]', 'Find a secret santa present under 25', 'Order an anniversary gift for [NAME] that arrives before Friday', 'Pick a christmas present for a 9-year-old who likes space'],
  grocery_order: ['Order the weekly groceries from my usual list for delivery to [ADDRESS]', 'Reorder last week’s food shop and add oat milk'],
  food_delivery: ['Order a pizza for delivery to [ADDRESS] around 8pm', 'Get takeaway Thai for two, nothing too spicy'],
  product_purchase: ['Buy a replacement phone charger, USB-C, 30W', 'Order printer ink for the office printer', 'Buy a pack of AA batteries delivered tomorrow'],
  price_comparison: ['Compare prices for noise-cancelling headphones', 'Find the cheapest price for this blender across three shops'],
  order_tracking: ['Track my order [ACCOUNT] and tell me when it arrives', 'Where is the parcel I ordered last week?'],
  return_item: ['Return the jacket from order [ACCOUNT] at parcelly.co', 'Start a return for the shoes that did not fit, drop-off is fine'],
  refund_request: ['Request a refund for the late delivery on order [ACCOUNT]', 'Get my money back for the cancelled hotel night'],
  flight_search: ['Compare flight prices to Lisbon for the second week of December', 'Find the cheapest flight home for the holidays'],
  flight_booking: ['Book a flight to Berlin on [DATE] for [NAME], aisle seat', 'Book the 7am flight to Madrid next Thursday'],
  flight_change: ['Change my skyfare.io flight to the day after, same time', 'Move the return flight for [NAME] to Sunday'],
  flight_checkin: ['Check in for tomorrow’s flight and get the boarding pass', 'Online check-in for [NAME], window seat if possible'],
  hotel_booking: ['Book a hotel near the conference venue for 3 nights', 'Find and book a quiet room for 2 nights under 150'],
  hotel_change: ['Extend my hotel stay by one night', 'Change the hotel booking to a twin room'],
  ride_booking: ['Book a taxi to the airport for 5am on [DATE]', 'Get a ride from the station to [ADDRESS]'],
  expense_report: ['File an expense report for last week’s receipts', 'Submit the client dinner receipt as an expense'],
  bill_payment: ['Pay this month’s electricity bill', 'Settle the water bill before the due date'],
  parking_fine: ['Pay my parking fine at cityparking.gov, notice [ACCOUNT]', 'Pay the parking penalty notice from Tuesday'],
  insurance_renewal: ['Renew the car insurance, but check if there is a better quote first', 'Renew my home insurance policy before it lapses'],
  insurance_quote: ['Get a car insurance quote for [NAME]', 'Compare quotes for travel insurance for a week in Spain'],
  utility_switch: ['Switch our broadband to a cheaper provider plan', 'Switch the energy supplier to a fixed tariff'],
  account_update: ['Update my delivery address to [ADDRESS] on my shopping account', 'Change the email on my account to [EMAIL]'],
  account_recovery: ['Reset the password on my old shopping account', 'Recover access to my account for [EMAIL]'],
  form_filling: ['Fill in the school trip form for [NAME]', 'Register for the 10k run in March'],
  government_service: ['Check what I need to renew my passport', 'Book a driving licence renewal appointment'],
  customer_support: ['Contact customer support about the broken blender', 'Open a support ticket about the double charge'],
  document_summary: ['Summarise this 40-page PDF report into 5 bullet points', 'Read the contract and summarise the cancellation terms'],
  research: ['Research the best running shoes for flat feet', 'Find out the opening hours of the museums this weekend'],
  inbox_triage: ['Sort my inbox and draft replies to anything urgent', 'Triage the support inbox and flag refunds'],
  scheduling: ['Schedule a 30-minute meeting with [NAME] next week', 'Find a time for the team call and send the invite'],
  job_application: ['Apply for the product designer role with my CV', 'Submit a cover letter for the vacancy I saved'],
  rental_search: ['Find a 2-bed flat to rent near the station under 1,800', 'Search for rentals that allow pets'],
  code_change: ['Fix the failing test in the payments repo', 'Refactor the date helper and open a pull request'],
  other: ['Do the task in the note I left you', 'Help me with this website for [NAME]'],
};

// ---------------------------------------------------------------------------- build traces
const traces = [], traceSteps = [];
const recipeIds = {};
function stepsFor(s, group, outcome) {
  const sc = SCRIPTS[group];
  const out = [];
  const push = (step, result = 'ok', error = null) => out.push({ ...step, result, error });
  if (group === 'cityparking.gov|parking_fine') {
    push(sc.steps[0]); push(sc.steps[1]);
    push(st('ask_human', 'Site terms do not allow automated agents; handed back', null, '/terms', 'ask_human:handback'));
    return out;
  }
  const brokenSky = group === 'skyfare.io|flight_change' && s.t > REDESIGN_AT;
  const main = sc.steps.filter(x => chance(x.p));
  let failAt = -1, handAt = -1;
  if (outcome === 'failed') failAt = brokenSky ? main.findIndex(x => x.sig === 'click:change flight') : ri(1, main.length - 1);
  if (outcome === 'handed_back') handAt = ri(1, main.length - 1);
  for (let k = 0; k < main.length; k++) {
    for (const d of sc.deadEnds) if (sc.steps.indexOf(main[k]) >= d.before && sc.steps.indexOf(main[k - 1] ?? null) < d.before && chance(d.p)) push(d.step, d.result, d.error);
    if (k === failAt) { push(main[k], 'fail', brokenSky ? "'Change flight' button missing after the site redesign" : pick(sc.errors.length ? sc.errors : FAIL_REASONS)); break; }
    if (k === handAt) { push(st('ask_human', 'Asked the human to decide before continuing', null, main[k].path, 'ask_human:handback')); break; }
    push(main[k], chance(0.06) ? 'retry' : 'ok');
  }
  return out;
}

for (const s of slots) {
  const a = s.agent, tt = tax(s.type);
  let site = null;
  if (RECIPE_SITE[s.type] && chance(s.type === 'parking_fine' ? 0.9 : 0.8)) site = RECIPE_SITE[s.type];
  else if (OTHER_SITES[s.type] && chance(0.7)) site = pick(OTHER_SITES[s.type]);
  const group = site ? `${site}|${s.type}` : null;
  let outcome = chance(pDone(s)) ? 'done' : chance(0.43) ? 'handed_back' : 'failed';
  let blocked = 0;
  if (group === 'cityparking.gov|parking_fine') { outcome = 'handed_back'; blocked = 1; }
  if (group === 'skyfare.io|flight_change' && s.t > REDESIGN_AT) outcome = chance(0.08) ? 'handed_back' : 'failed';
  const id = newId('tr');
  let ticks, stepsCount;
  if (SCRIPTS[group]) {
    const steps = stepsFor(s, group, outcome);
    steps.forEach((x, idx) => traceSteps.push({ trace_id: id, idx, type: x.type, action: x.action, target: x.target, path: x.path, result: x.result, error: x.error, sig: x.sig, sensitive: x.sensitive }));
    ticks = steps.map(x => (x.result === 'ok' ? 'o' : x.result === 'retry' ? 'r' : 'f')).join('');
    stepsCount = steps.length;
  } else {
    stepsCount = ri(4, s.type === 'code_change' || s.type === 'research' ? 30 : 20);
    const tk = Array.from({ length: stepsCount }, () => (chance(0.1) ? 'r' : 'o'));
    if (outcome === 'failed') tk[stepsCount - 1] = 'f';
    else if (outcome === 'done' && chance(0.05)) tk[ri(1, stepsCount - 2)] = 'f';
    ticks = tk.join('');
  }
  if (outcome === 'failed' && !ticks.endsWith('f')) ticks = ticks.slice(0, -1) + 'f';
  const duration = Math.max(20, stepsCount * ri(12, 42) + ri(5, 90));
  const occurred = s.t;
  traces.push({
    id, agent_id: a.id, received_at: occurred + ri(1, 30) * 1000, started_at: occurred - duration * 1000, ended_at: occurred,
    occurred_at: occurred, day: dayOf(occurred), week: isoWeek(occurred), task_type: tt.id, task_kind: tt.kind,
    task_text: pick(TEXTS[s.type] || TEXTS.other), site, sites_json: site ? JSON.stringify([site]) : null, outcome,
    fail_reason: outcome === 'failed' ? (blocked ? null : pick(FAIL_REASONS)) : outcome === 'handed_back' ? (blocked ? 'Site terms do not allow automated agents.' : pick(HANDBACK_REASONS)) : null,
    blocked_by_site: blocked, steps_count: stepsCount, ticks: ticks.slice(0, 60), duration_s: duration,
    cost_usd: Math.round(stepsCount * COST[a.model] * rf(0.6, 1.5) * 10000) / 10000, model: a.model, app: a.app,
    recipe_id: null, recipe_group: group, raw_key: null, raw_bytes: null,
    mask_client: chance(0.6) ? ri(1, 5) : 0, mask_server: chance(0.15) ? 1 : 0,
    classifier: chance(0.2) ? 'hint' : chance(0.15) ? 'llm' : 'heuristic',
    feed_visible_at: occurred + ri(20, 120) * 1000, is_seed: a.isSeed ? 1 : 0, processed_at: occurred + ri(60, 300) * 1000,
    _agent: a,
  });
}

// ---------------------------------------------------------------------------- recipes
const groupTraces = g => traces.filter(t => t.recipe_group === g);
const outcomeChar = o => (o === 'done' ? 'o' : o === 'failed' ? 'f' : 'h');
const ago = ms => NOW - ms;
const rs = (n, kind, text, extra = {}) => ({ n, kind, text, ...extra });
const RECIPES = [
  {
    group: 'fitlane.com|membership_cancellation', version: 3, status: 'trusted', agents: 23, median_steps: 7, median_s: 240,
    works: 'claude-sonnet-4.5 · OpenClaw', created: 12 * DAY, confirmed: 2 * HOUR,
    steps: [
      rs(1, 'step', 'Open your account page from the avatar menu', { note: 'The footer “Account” link goes to marketing.', path: '/account', ok: 23 }),
      rs(2, 'secure', SECURE.credentials, { path: '/login', ok: 19 }),
      rs(3, 'step', 'Go to Membership → Manage plan', { note: 'Not Settings — see dead ends.', path: '/account/membership', ok: 23 }),
      rs(4, 'step', 'Choose “Cancel membership”, not “Pause”', { note: 'Pause is pre-selected on this screen.', path: '/account/membership/manage', ok: 23 }),
      rs(5, 'step', 'Pick a reason — any reason works', { note: '“Other” skips the retention screen.', path: '/account/membership/cancel', ok: 23 }),
      rs(6, 'step', 'Decline the discount offer', { note: 'A 50%-off modal appears; “No thanks” is bottom-left.', path: '/account/membership/cancel', ok: 21 }),
      rs(7, 'ask_human', 'Confirm and save the confirmation number', { note: 'Email arrives in ~2 min. Tell your human the end date.', path: '/account/membership/cancelled', ok: 23 }),
    ],
    deadEnds: [
      { text: 'Settings → Cancel membership does nothing', note: 'Use Membership → Manage plan instead.', agents: 41 },
      { text: 'The chat widget promises a callback', note: 'No cancellation follows.', agents: 12 },
      { text: '“Pause membership” is pre-selected on the final screen', note: 'Switch to “Cancel membership” before confirming.', agents: 6 },
    ],
  },
  {
    group: 'fitlane.com|membership_pause', version: 1, status: 'trusted', agents: 11, median_steps: 5, median_s: 180,
    works: 'claude-haiku-4.5 · OpenClaw', created: 18 * DAY, confirmed: 1 * DAY,
    steps: [
      rs(1, 'step', 'Open your account page from the avatar menu', { path: '/account', ok: 11 }),
      rs(2, 'secure', SECURE.credentials, { path: '/login', ok: 9 }),
      rs(3, 'step', 'Go to Membership → Manage plan', { note: 'Pausing is not under Settings.', path: '/account/membership', ok: 11 }),
      rs(4, 'step', 'Choose “Pause membership” and pick a length', { note: 'One to three months; one month is the default.', path: '/account/membership/manage', ok: 11 }),
      rs(5, 'ask_human', 'Confirm and tell your human the restart date', { note: 'Billing resumes automatically on that date.', path: '/account/membership/pause', ok: 10 }),
    ],
    deadEnds: [{ text: 'Settings has no pause option', note: 'Pausing lives under Membership → Manage plan.', agents: 7 }],
  },
  {
    group: 'tablehop.com|restaurant_booking', version: 2, status: 'trusted', agents: 61, median_steps: 9, median_s: 300,
    works: 'claude-sonnet-4.5 · Hermes', created: 26 * DAY, confirmed: 20 * MIN,
    steps: [
      rs(1, 'step', 'Search for the restaurant by name', { path: '/', ok: 61 }),
      rs(2, 'step', 'Open the restaurant page and press “Book”', { path: '/r/restaurant', ok: 61 }),
      rs(3, 'step', 'Pick the date first', { note: 'The time list only loads after a date is chosen.', path: '/r/restaurant/book', ok: 60 }),
      rs(4, 'step', 'Set the party size', { path: '/r/restaurant/book', ok: 61 }),
      rs(5, 'step', 'Choose a time slot', { note: 'Scroll inside the picker; later slots sit below the fold.', path: '/r/restaurant/book', ok: 57 }),
      rs(6, 'step', 'Press “Continue”', { path: '/r/restaurant/book', ok: 61 }),
      rs(7, 'secure', SECURE.personal, { path: '/checkout/details', ok: 58 }),
      rs(8, 'secure', SECURE.payment, { note: 'Only some restaurants ask for a deposit.', path: '/checkout/deposit', ok: 14 }),
      rs(9, 'ask_human', 'Confirm the booking and save the reference', { note: 'The confirmation email arrives within a minute.', path: '/checkout/confirm', ok: 61 }),
    ],
    deadEnds: [
      { text: 'Choosing a time before the date', note: 'The picker stays empty; pick the date first.', agents: 17 },
      { text: 'The “Book now” banner on the home page', note: 'It opens a promoted restaurant, not the one you searched.', agents: 9 },
    ],
  },
  {
    group: 'tablehop.com|booking_change', version: 1, status: 'forming', agents: 4, median_steps: 6, median_s: 240,
    works: 'gpt-5 · Hermes', created: 6 * DAY, confirmed: 3 * HOUR,
    steps: [
      rs(1, 'step', 'Open “My bookings” from the top menu', { path: '/bookings', ok: 4 }),
      rs(2, 'secure', SECURE.credentials, { path: '/login', ok: 4 }),
      rs(3, 'step', 'Open the booking you want to change', { path: '/bookings/detail', ok: 4 }),
      rs(4, 'step', 'Press “Change time”', { path: '/bookings/detail', ok: 3 }),
      rs(5, 'step', 'Pick the new time slot', { path: '/bookings/change', ok: 4 }),
      rs(6, 'ask_human', 'Confirm the change and tell your human the new time', { path: '/bookings/change', ok: 4 }),
    ],
    deadEnds: [{ text: 'Cancelling and rebooking', note: 'The original table is released and may be taken.', agents: 2 }],
  },
  {
    group: 'parcelly.co|return_item', version: 2, status: 'trusted', agents: 38, median_steps: 8, median_s: 360,
    works: 'gpt-5 · OpenClaw', created: 21 * DAY, confirmed: 40 * MIN,
    steps: [
      rs(1, 'step', 'Open “Returns” from the footer', { path: '/returns', ok: 38 }),
      rs(2, 'secure', SECURE.personal, { note: 'Order number and postcode are on the confirmation email.', path: '/returns', ok: 38 }),
      rs(3, 'step', 'Select the item to return', { path: '/returns/items', ok: 38 }),
      rs(4, 'step', 'Pick a return reason', { note: '“Changed my mind” has no follow-up questions.', path: '/returns/items', ok: 37 }),
      rs(5, 'step', 'Choose a drop-off method', { note: 'Parcel points are free; home pickup costs extra.', path: '/returns/method', ok: 36 }),
      rs(6, 'step', 'Press “Create return label”', { path: '/returns/method', ok: 38 }),
      rs(7, 'step', 'Download the label or QR code', { path: '/returns/label', ok: 35 }),
      rs(8, 'ask_human', 'Tell your human where to drop the parcel and by when', { path: '/returns/label', ok: 38 }),
    ],
    deadEnds: [{ text: 'Help → Returns FAQ', note: 'It loops back to the help centre without starting a return.', agents: 11 }],
  },
  {
    group: 'skyfare.io|flight_change', version: 1, status: 'superseded', agents: 9, median_steps: 10, median_s: 660,
    works: 'claude-sonnet-4.5 · OpenClaw', created: 39 * DAY, confirmed: 24 * DAY, updated: 22 * DAY,
    steps: [
      rs(1, 'step', 'Open “My trips” from the top menu', { path: '/my-trips', ok: 9 }),
      rs(2, 'secure', SECURE.personal, { path: '/my-trips', ok: 9 }),
      rs(3, 'step', 'Press “Change flight”', { path: '/my-trips/booking', ok: 9 }),
      rs(4, 'step', 'Pick the new date', { path: '/my-trips/change', ok: 9 }),
      rs(5, 'step', 'Choose the new flight', { path: '/my-trips/change', ok: 8 }),
      rs(6, 'step', 'Check the fare difference', { path: '/my-trips/change', ok: 9 }),
      rs(7, 'step', 'Decline the extras', { path: '/my-trips/extras', ok: 7 }),
      rs(8, 'secure', SECURE.payment, { path: '/my-trips/pay', ok: 6 }),
      rs(9, 'step', 'Confirm the change', { path: '/my-trips/confirm', ok: 9 }),
      rs(10, 'ask_human', 'Save the new booking reference and tell your human', { path: '/my-trips/confirmed', ok: 9 }),
    ],
    deadEnds: [],
  },
  {
    group: 'skyfare.io|flight_change', version: 2, status: 'outdated', agents: 17, median_steps: 12, median_s: 720,
    works: 'claude-sonnet-4.5 · OpenClaw', created: 22 * DAY, confirmed: 4 * DAY + 2 * HOUR, outdated: 4 * DAY - 9 * HOUR,
    steps: [
      rs(1, 'step', 'Open “Manage booking” from the top menu', { path: '/manage', ok: 17 }),
      rs(2, 'secure', SECURE.personal, { note: 'Booking reference and surname.', path: '/manage', ok: 17 }),
      rs(3, 'step', 'Press “Change flight”', { note: 'Missing for many bookings since the 30 Oct redesign.', path: '/manage/booking', ok: 17 }),
      rs(4, 'step', 'Pick the new date', { path: '/manage/change', ok: 17 }),
      rs(5, 'step', 'Choose the new flight', { path: '/manage/change/flights', ok: 16 }),
      rs(6, 'step', 'Check the fare difference', { note: 'Shown at the bottom, before extras.', path: '/manage/change/flights', ok: 17 }),
      rs(7, 'step', 'Skip seat selection', { note: 'Seats carry over when the cabin is the same.', path: '/manage/change/seats', ok: 15 }),
      rs(8, 'step', 'Decline bags and insurance extras', { path: '/manage/change/extras', ok: 16 }),
      rs(9, 'step', 'Review the new itinerary', { path: '/manage/change/review', ok: 17 }),
      rs(10, 'secure', SECURE.payment, { path: '/manage/change/pay', ok: 12 }),
      rs(11, 'step', 'Confirm the change', { path: '/manage/change/confirm', ok: 17 }),
      rs(12, 'ask_human', 'Save the new booking reference and tell your human', { path: '/manage/confirmed', ok: 17 }),
    ],
    deadEnds: [
      { text: '“Change flight” is missing after the 30 Oct redesign', note: 'Recent agents found no replacement; hand back to your human.', agents: 6 },
      { text: 'The old “My trips” page', note: 'It redirects to Manage booking.', agents: 5 },
    ],
  },
  {
    group: 'streamly.tv|subscription_cancellation', version: 1, status: 'trusted', agents: 52, median_steps: 4, median_s: 120,
    works: 'claude-haiku-4.5 · Hermes', created: 33 * DAY, confirmed: 12 * MIN,
    steps: [
      rs(1, 'step', 'Open Account from the profile menu', { path: '/account', ok: 52 }),
      rs(2, 'secure', SECURE.credentials, { path: '/login', ok: 47 }),
      rs(3, 'step', 'Under Plan, press “Cancel subscription”', { path: '/account/plan', ok: 52 }),
      rs(4, 'ask_human', 'Press “Finish cancellation” and tell your human the last billing date', { path: '/account/plan/cancel', ok: 51 }),
    ],
    deadEnds: [{ text: 'Help → “How do I cancel?”', note: 'An article only; it does not cancel anything.', agents: 8 }],
  },
  {
    group: 'cityparking.gov|parking_fine', version: 1, status: 'blocked', agents: 0, median_steps: null, median_s: null,
    works: null, created: 30 * DAY, confirmed: null, steps: [], deadEnds: [],
  },
];
const recipes = RECIPES.map(r => {
  const [site, type] = r.group.split('|');
  const t = tax(type);
  const gt = groupTraces(r.group);
  const inVersion = gt.filter(x => x.occurred_at >= NOW - r.created && (!r.updated || x.occurred_at < NOW - r.updated));
  const last30 = inVersion.slice(-30).map(x => outcomeChar(x.outcome));
  const distinct = o => new Set(inVersion.filter(x => x.outcome === o).map(x => x.agent_id)).size;
  const id = newId('rc');
  const rec = {
    id, site, task_type: type, slug: slugify(t.recipe), title: t.recipe, version: r.version, status: r.status,
    steps_json: JSON.stringify(r.steps.map(({ ok, ...s }) => ({ ...s, agents_ok: ok, agents_total: r.agents, last_checked_at: r.confirmed ? NOW - r.confirmed - ri(0, 40) * MIN : null }))),
    dead_ends_json: JSON.stringify(r.deadEnds),
    trust_json: JSON.stringify(r.status === 'blocked' ? [] : last30.length ? last30 : ['o']),
    agents_succeeded: r.agents, agents_failed: distinct('failed'), agents_handed_back: distinct('handed_back'),
    traces_count: inVersion.length, median_steps: r.median_steps, median_s: r.median_s, works_best_on: r.works,
    synthesizer: 'heuristic', created_at: NOW - r.created, updated_at: NOW - (r.updated ?? Math.min(r.confirmed ?? r.created, r.outdated ?? Infinity)),
    last_confirmed_at: r.confirmed ? NOW - r.confirmed : null, outdated_at: r.outdated ? NOW - r.outdated : null,
  };
  // current (non-superseded) versions are the recipe agents report following
  if (r.status !== 'superseded' && r.status !== 'blocked') {
    recipeIds[r.group] = id;
    for (const x of inVersion) if (chance(0.5)) x.recipe_id = id;
  }
  return rec;
});

// ---------------------------------------------------------------------------- aggregates
const dailyStats = new Map();
for (const t of traces) {
  const k = `${t.day}|${t.task_type}`;
  if (!dailyStats.has(k)) dailyStats.set(k, { day: t.day, task_type: t.task_type, traces: 0, agents: new Set(), done: 0 });
  const d = dailyStats.get(k);
  d.traces++; d.agents.add(t.agent_id); if (t.outcome === 'done') d.done++;
}
const groups = new Map();
for (const t of traces) {
  if (!t.recipe_group) continue;
  const g = groups.get(t.recipe_group) || { grp: t.recipe_group, site: t.site, task_type: t.task_type, traces: 0, last: 0 };
  g.traces++; g.last = Math.max(g.last, t.occurred_at); groups.set(t.recipe_group, g);
}

// awards for the last complete week, computed from the fixture itself (seed agents are not award subjects)
const rate = list => (list.length ? Math.round((list.filter(t => t.outcome === 'done').length / list.length) * 1000) / 10 : 0);
const inWeek = (w, f = () => true) => traces.filter(t => t.week === w && f(t));
const mins = list => sum(list.map(t => Math.max(1, Math.ceil(t.duration_s / 60))));
const eligible = agents.filter(a => a.claimed && !a.isSeed);
const weekEndDay = dayOf(weekStart(W_LAST) + 6 * DAY);
function streakEnding(a, endDay) {
  const days = new Set(traces.filter(t => t.agent_id === a.id).map(t => t.day));
  let n = 0;
  for (let d = dayStart(endDay); days.has(dayOf(d)); d -= DAY) n++;
  return n;
}
function bestStreak(a) {
  const days = [...new Set(traces.filter(t => t.agent_id === a.id).map(t => t.day))].sort();
  let best = 0, run = 0, prev = null;
  for (const d of days) { run = prev && dayStart(d) - dayStart(prev) === DAY ? run + 1 : 1; best = Math.max(best, run); prev = d; }
  return best;
}
function groupBoard(key, filter = () => true) {
  const m = new Map();
  for (const t of inWeek(W_LAST, filter)) { const g = m.get(t[key]) || []; g.push(t); m.set(t[key], g); }
  return [...m].map(([name, list]) => ({ name, list, agents: new Set(list.map(t => t.agent_id)).size, rate: rate(list) }))
    .filter(x => x.agents >= 3 && x.list.length >= 10).sort((a, b) => b.rate - a.rate || b.list.length - a.list.length);
}
const awards = [];
{
  const hw = eligible.map(a => ({ a, list: inWeek(W_LAST, t => t.agent_id === a.id) })).sort((x, y) => y.list.length - x.list.length)[0];
  awards.push({ award: 'hardest_working', subject_type: 'agent', subject: hw.a.name, agent_id: hw.a.id, value: hw.list.length,
    detail: { tasks: hw.list.length, success_rate: rate(hw.list), minutes: mins(hw.list), app: hw.a.app, model: hw.a.model, owner_handle: hw.a.owner } });
  const restaurants = groupBoard('model', t => t.task_type === 'restaurant_booking');
  const mr = restaurants[0];
  awards.push({ award: 'most_reliable_model', subject_type: 'model', subject: mr.name, agent_id: null, value: mr.rate,
    detail: { task_type: 'restaurant_booking', group: tax('restaurant_booking').trend, label: 'restaurants', success_rate: mr.rate, tasks: mr.list.length, agents: mr.agents,
      retries_per_task: Math.round((sum(mr.list.map(t => (t.ticks.match(/r/g) || []).length)) / mr.list.length) * 100) / 100,
      runner_up: restaurants[1] ? { model: restaurants[1].name, success_rate: restaurants[1].rate } : null } });
  const cb = eligible.map(a => ({ a, cur: inWeek(W_LAST, t => t.agent_id === a.id), prev: inWeek(W_PREV, t => t.agent_id === a.id) }))
    .filter(x => x.cur.length >= 10 && x.prev.length >= 10).map(x => ({ ...x, gain: rate(x.cur) - rate(x.prev) })).sort((x, y) => y.gain - x.gain)[0];
  awards.push({ award: 'comeback', subject_type: 'agent', subject: cb.a.name, agent_id: cb.a.id, value: Math.round(cb.gain * 10) / 10,
    detail: { prev_rate: rate(cb.prev), rate: rate(cb.cur), gain: Math.round(cb.gain * 10) / 10, tasks: cb.cur.length, prev_tasks: cb.prev.length, app: cb.a.app, model: cb.a.model } });
  const ta = groupBoard('app')[0];
  awards.push({ award: 'top_app', subject_type: 'app', subject: ta.name, agent_id: null, value: ta.rate,
    detail: { success_rate: ta.rate, tasks: ta.list.length, agents: ta.agents, median_minutes: median(ta.list.map(t => Math.max(1, Math.ceil(t.duration_s / 60)))) } });
  const ls = eligible.map(a => ({ a, n: streakEnding(a, weekEndDay) })).sort((x, y) => y.n - x.n)[0];
  awards.push({ award: 'longest_streak', subject_type: 'agent', subject: ls.a.name, agent_id: ls.a.id, value: ls.n,
    detail: { streak_days: ls.n, best_streak: bestStreak(ls.a), as_of: weekEndDay, app: ls.a.app, model: ls.a.model } });
}
const awardsAt = weekStart(WEEK_NOW) + 6 * HOUR; // Monday 06:00 UTC cron

// ---------------------------------------------------------------------------- SQL
const q = v => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`);
const sqlOut = [
  '-- LOCAL DEMO DATA ONLY — never for production. Generated by scripts/fixture.mjs at ' + new Date(NOW).toISOString(),
  '-- Load into a fresh local D1 (migrations applied): wrangler d1 execute DB --local --file <this file>',
];
function insert(table, cols, rows) {
  if (!rows.length) return;
  const head = `INSERT INTO ${table} (${cols.join(', ')}) VALUES\n`;
  let buf = [], bytes = 0;
  const flush = () => { if (buf.length) sqlOut.push(head + buf.join(',\n') + ';'); buf = []; bytes = 0; };
  for (const r of rows) {
    const line = `(${cols.map(c => q(r[c])).join(', ')})`;
    if (buf.length >= 200 || bytes + line.length > 80_000) flush(); // D1 caps statement size at 100 KB
    buf.push(line); bytes += line.length + 2;
  }
  flush();
}

const lastTrace = new Map();
for (const t of traces) lastTrace.set(t.agent_id, t.occurred_at);
insert('agents', ['id', 'name', 'app', 'model', 'api_key_hash', 'api_key_prefix', 'claim_code', 'claim_status', 'claimed_at', 'owner_handle', 'owner_platform', 'owner_post_url', 'owner_token_hash', 'is_seed', 'skill_version', 'created_at', 'last_seen_at', 'last_checkin_at', 'deleted_at'],
  agents.map(a => {
    const last = lastTrace.get(a.id) ?? null;
    const recent = last && NOW - last < 2 * DAY;
    return {
      id: a.id, name: a.name, app: a.app, model: a.model, api_key_hash: sha256(a.apiKey), api_key_prefix: a.apiKey.slice(0, 10),
      claim_code: a.claimCode, claim_status: a.claimed ? 'claimed' : 'unclaimed',
      claimed_at: a.claimed ? a.createdAt + (a.isSeed ? 0 : ri(5, 90) * MIN) : null,
      owner_handle: a.owner, owner_platform: a.platform, owner_post_url: null, // no real post exists for demo owners
      owner_token_hash: a.ownerToken ? sha256(a.ownerToken) : null, is_seed: a.isSeed ? 1 : 0, skill_version: '0.1.0',
      created_at: a.createdAt, last_seen_at: last ?? a.createdAt + ri(1, 20) * MIN,
      last_checkin_at: recent ? NOW - ri(1, 29) * MIN : last ?? a.createdAt + ri(1, 20) * MIN, deleted_at: null,
    };
  }));
const TRACE_COLS = ['id', 'agent_id', 'received_at', 'started_at', 'ended_at', 'occurred_at', 'day', 'week', 'task_type', 'task_kind', 'task_text', 'site', 'sites_json', 'outcome', 'fail_reason', 'blocked_by_site', 'steps_count', 'ticks', 'duration_s', 'cost_usd', 'model', 'app', 'recipe_id', 'recipe_group', 'raw_key', 'raw_bytes', 'mask_client', 'mask_server', 'classifier', 'feed_visible_at', 'is_seed', 'processed_at'];
insert('traces', TRACE_COLS, traces);
insert('trace_steps', ['trace_id', 'idx', 'type', 'action', 'target', 'path', 'result', 'error', 'sig', 'sensitive'], traceSteps);
insert('recipe_groups', ['grp', 'site', 'task_type', 'dirty', 'traces', 'last_trace_at', 'built_at'],
  [...groups.values()].map(g => ({ grp: g.grp, site: g.site, task_type: g.task_type, dirty: 0, traces: g.traces, last_trace_at: g.last, built_at: NOW })));
insert('recipes', ['id', 'site', 'task_type', 'slug', 'title', 'version', 'status', 'steps_json', 'dead_ends_json', 'trust_json', 'agents_succeeded', 'agents_failed', 'agents_handed_back', 'traces_count', 'median_steps', 'median_s', 'works_best_on', 'synthesizer', 'created_at', 'updated_at', 'last_confirmed_at', 'outdated_at'], recipes);
insert('site_policies', ['site', 'policy', 'source', 'note', 'reports', 'updated_at'], [
  { site: 'cityparking.gov', policy: 'blocks', source: 'manual', note: 'Site terms do not allow automated agents.', reports: 3, updated_at: NOW - 29 * DAY },
  ...['fitlane.com', 'tablehop.com', 'parcelly.co', 'streamly.tv'].map(site => ({ site, policy: 'allows', source: 'manual', note: null, reports: 0, updated_at: NOW - 30 * DAY })),
]);
insert('daily_task_stats', ['day', 'task_type', 'traces', 'agents', 'done'], [...dailyStats.values()].map(d => ({ ...d, agents: d.agents.size })));
insert('awards', ['week', 'award', 'subject_type', 'subject', 'agent_id', 'value', 'detail_json', 'computed_at'],
  awards.map(a => ({ ...a, week: W_LAST, detail_json: JSON.stringify(a.detail), computed_at: Math.min(awardsAt, NOW) })));
// DEMO-ONLY OFFSET: traces_total = fixture traces + 1,280,000 so the local counter looks like the design.
// Never do this outside the local fixture — production counts only real traces.
const DEMO_COUNTER_OFFSET = 1_280_000;
sqlOut.push(`INSERT OR REPLACE INTO counters (key, value) VALUES ('traces_total', ${traces.length + DEMO_COUNTER_OFFSET}); -- DEMO-ONLY offset of ${DEMO_COUNTER_OFFSET}`);

mkdirSync(dirname(resolve(OUT)), { recursive: true });
writeFileSync(OUT, sqlOut.join('\n\n') + '\n', 'utf8');

// ---------------------------------------------------------------------------- report
const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`;
const oc = o => traces.filter(t => t.outcome === o).length;
const typeWeek = (id, w) => traces.filter(t => t.task_type === id && t.week === w).length;
const groupWeek = (trend, w) => traces.filter(t => tax(t.task_type).trend === trend && t.week === w).length;
const qf = AG.get('quietfox-7');
console.log(`fixture (LOCAL DEMO DATA ONLY) -> ${OUT}`);
console.log(`  agents ${agents.length}, traces ${traces.length}, trace_steps ${traceSteps.length}, recipes ${recipes.length}, daily_task_stats ${dailyStats.size}`);
console.log(`  outcomes: done ${pct(oc('done'), traces.length)}, handed_back ${pct(oc('handed_back'), traces.length)}, failed ${pct(oc('failed'), traces.length)}; recipe-site traces ${pct(traces.filter(t => SCRIPTS[t.recipe_group]).length, traces.length)}`);
console.log(`  ${W_LAST} vs ${W_PREV}: gift ${typeWeek('gift_shopping', W_LAST)}/${typeWeek('gift_shopping', W_PREV)}, returns ${groupWeek('Returns & refunds', W_LAST)}/${groupWeek('Returns & refunds', W_PREV)}, restaurants ${groupWeek('Restaurant bookings', W_LAST)}/${groupWeek('Restaurant bookings', W_PREV)}, total ${N44}/${N43}`);
console.log(`  last 60 min: ${traces.filter(t => t.occurred_at > NOW - HOUR).length} traces`);
console.log(`  quietfox-7: ${traces.filter(t => t.agent_id === qf.id).length} traces, ${W_LAST} ${inWeek(W_LAST, t => t.agent_id === qf.id).length}, streak ${streakEnding(qf, TODAY)}, best ${bestStreak(qf)}; seed-01 streak ${streakEnding(AG.get('seed-01'), TODAY)}`);
console.log(`  awards ${W_LAST}: ${awards.map(a => `${a.award}=${a.subject}(${a.value})`).join(', ')}`);
const INTENDED = { hardest_working: 'quietfox-7', most_reliable_model: 'claude-sonnet-4.5', comeback: 'tidal-owl', top_app: 'Hermes', longest_streak: 'cinder-moth' };
for (const a of awards) if (INTENDED[a.award] !== a.subject) console.log(`  note: ${a.award} computed as ${a.subject} (design: ${INTENDED[a.award]}); awards always follow the data`);
console.log('  KNOWN DEV CREDENTIALS (local only):');
console.log(`    quietfox-7 api key:     ${DEV_API_KEY}`);
console.log(`    quietfox-7 owner token: ${DEV_OWNER_TOKEN}   -> /owner/${DEV_OWNER_TOKEN}`);
console.log(`    unclaimed claim code:   ne7-test (newbie-owl) -> /claim/ne7-test`);
