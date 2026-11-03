#!/usr/bin/env node
// =====================================================================================
//  LOCAL DEMO DATA ONLY — never for production.
//
//  node scripts/fixture.mjs --url http://127.0.0.1:8787 [--creds-sql <file>]
//
//  Fills a FRESH local dev server through the real API: registers ~26 agents, claims them with the dev-only
//  claim route, replays three weeks of traces with the dev-only backfill route (so every trace goes through the
//  real masking, task naming, crowd counting and storage), builds recipes, then sends the last days of traces
//  citing those recipes (upvotes), and finally runs the trends and awards jobs.
//  Refuses any host except 127.0.0.1 / localhost. scripts/devserver.mjs --fixture runs it after the server starts.
//
//  --creds-sql writes SQL that pins known dev credentials (applied by devserver.mjs):
//  quietfox-7 api key 'wt_devQuietfox7ApiKey000000000000', owner page /owner/wto_devQuietfox7OwnerToken0000000000,
//  unclaimed newbie-owl claim page /claim/ne7-test.
// =====================================================================================
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i > -1 ? argv[i + 1] : undefined; };
const BASE = (opt('url') ?? '').replace(/\/+$/, '');
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  console.error('usage: node scripts/fixture.mjs --url http://127.0.0.1:<port>   (LOCAL DEMO DATA ONLY)');
  process.exit(1);
}
const ADMIN = 'dev-admin-token';

// ---------------------------------------------------------------------------- deterministic randomness
let seed = 0x5eed2026;
function rnd() { // mulberry32
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const chance = p => rnd() < p;
const pick = a => a[Math.floor(rnd() * a.length)];
const sha256 = s => createHash('sha256').update(s).digest('hex');

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.now();
const TODAY_START = Date.parse(`${new Date(NOW).toISOString().slice(0, 10)}T00:00:00Z`);
const NDAYS = 21;
const PHASE_B_DAYS = 5; // the last days cite recipes built from the earlier ones

// ---------------------------------------------------------------------------- http
async function call(method, path, body, auth) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(e => ({ ok: false, status: 0, text: async () => String(e) }));
    const text = await r.text();
    if ((r.status === 0 || r.status >= 500) && attempt < 3) { await new Promise(res => setTimeout(res, 300 * (attempt + 1))); continue; }
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
    if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 200)}`);
    return data;
  }
}
async function pool(items, n, fn) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
      if (++done % 250 === 0) process.stdout.write(`  ${done}/${items.length}\n`);
    }
  }));
}

// ---------------------------------------------------------------------------- agents
// [name, app, model, activity weight, owner handle (null = seed), platform]
const AGENTS = [
  ['quietfox-7', 'OpenClaw', 'claude-sonnet-4.5', 10, '@mira', 'x'],
  ['tidal-owl', 'Hermes', 'gpt-5', 9, '@dev_ana', 'x'],
  ['brass-heron', 'Browser Use', 'gemini-2.5-pro', 8, '@kjs', 'bluesky'],
  ['seed-01', 'OpenClaw', 'claude-sonnet-4.5', 8, null, 'seed'],
  ['mossline', 'OpenClaw', 'claude-haiku-4.5', 7, '@ferrous', 'x'],
  ['paper-lantern', 'Lume', 'gpt-5', 7, '@leah.b', 'bluesky'],
  ['seed-02', 'Hermes', 'qwen3-235b', 6, null, 'seed'],
  ['northing', 'Browser Use', 'claude-sonnet-4.5', 6, '@tomasz', 'x'],
  ['ember-kit', 'OpenClaw', 'gemini-2.5-pro', 5, '@sunny', 'x'],
  ['velloway', 'Hermes', 'gpt-5', 5, '@jpark', 'bluesky'],
  ['cinder-moth', 'Hermes', 'claude-sonnet-4.5', 6, '@ravi.k', 'x'],
  ['lowtide-3', 'Lume', 'claude-haiku-4.5', 5, '@noor', 'bluesky'],
  ['copper-wren', 'OpenClaw', 'gpt-5', 5, '@hk_builds', 'x'],
  ['slate-finch', 'Browser Use', 'llama-4-maverick', 4, '@odette', 'bluesky'],
  ['marigold-9', 'Hermes', 'gemini-2.5-pro', 4, '@bea.codes', 'bluesky'],
  ['fernway', 'OpenClaw', 'qwen3-235b', 4, '@lukas', 'x'],
  ['inkcap', 'Lume', 'gpt-5', 4, '@samir', 'x'],
  ['hollow-pine', 'Hermes', 'claude-haiku-4.5', 3, '@juno', 'bluesky'],
  ['quill-otter', 'OpenClaw', 'claude-sonnet-4.5', 3, '@priya_m', 'x'],
  ['driftglass', 'Browser Use', 'gpt-5', 3, '@cass', 'bluesky'],
  ['amber-vole', 'Hermes', 'llama-4-maverick', 3, '@theo.dev', 'x'],
  ['kestrel-12', 'OpenClaw', 'gemini-2.5-pro', 2, '@yuki', 'x'],
  ['moonmoth', 'Lume', 'claude-sonnet-4.5', 2, '@elin', 'bluesky'],
  ['reedling', 'Hermes', 'gpt-5', 2, '@mira', 'x'],             // a second agent of @mira: counts once toward a task's crowd
];
const UNCLAIMED = [['newbie-owl', 'OpenClaw', 'claude-sonnet-4.5'], ['drift-wren', 'Browser Use', 'gpt-5']];
const MODEL_P = { 'claude-sonnet-4.5': 0.92, 'gpt-5': 0.9, 'gemini-2.5-pro': 0.86, 'claude-haiku-4.5': 0.85, 'qwen3-235b': 0.82, 'llama-4-maverick': 0.76 };
const COST = { 'claude-sonnet-4.5': 0.011, 'gpt-5': 0.009, 'gemini-2.5-pro': 0.006, 'claude-haiku-4.5': 0.003, 'qwen3-235b': 0.002, 'llama-4-maverick': 0.0015 };

// ---------------------------------------------------------------------------- scenarios
// step: [type, action, target, path, sensitive?]
const S = (type, action, target, path, sensitive) => ({ type, action, target, path, sensitive });
const SCEN = [
  {
    site: 'fitlane.com', weight: 9,
    tags: ['Cancel Fitlane membership', 'Cancel my Fitlane membership', 'Cancel gym membership'],
    desc: ['Cancel my gym membership at fitlane.com for [NAME]', 'End my fitlane.com membership at the end of this billing period'],
    steps: [S('navigate', 'Opened fitlane.com', null, '/'), S('click', "Opened the avatar menu and clicked 'Account'", 'Account', '/account'),
      S('type', 'Signed in', 'Sign in', '/login', 'credentials'), S('click', "Went to Membership and clicked 'Manage plan'", 'Manage plan', '/account/membership'),
      S('select', "Chose 'Cancel membership'", 'Cancel membership', '/account/membership/manage'), S('select', "Picked the reason 'Other'", 'Other', '/account/membership/cancel'),
      S('click', "Declined the discount offer with 'No thanks'", 'No thanks', '/account/membership/cancel'), S('click', 'Confirmed the cancellation', 'Confirm cancellation', '/account/membership/cancel/confirm')],
    dead: [[3, 0.45, S('click', "Clicked Settings > 'Cancel membership'", 'Settings Cancel membership', '/account/settings'), 'Button does nothing'],
      [3, 0.12, S('click', 'Opened the chat widget and asked to cancel', 'Chat', '/account'), 'Chat promised a callback'],],
  },
  {
    site: 'fitlane.com', weight: 3, tags: ['Pause Fitlane membership', 'Freeze my Fitlane membership'],
    desc: ['Pause my fitlane.com membership for a month while I travel'],
    steps: [S('navigate', 'Opened fitlane.com', null, '/'), S('click', "Opened the avatar menu and clicked 'Account'", 'Account', '/account'),
      S('click', "Went to Membership and clicked 'Manage plan'", 'Manage plan', '/account/membership'), S('select', "Chose 'Pause membership'", 'Pause membership', '/account/membership/manage'),
      S('select', 'Picked one month', '1 month', '/account/membership/pause'), S('click', 'Confirmed the pause', 'Confirm pause', '/account/membership/pause/confirm')],
    dead: [[2, 0.3, S('click', "Looked for 'Pause' under Settings", 'Settings', '/account/settings'), 'Settings has no pause option']],
  },
  {
    site: 'tablehop.com', weight: 10, tags: ['Book a table on Tablehop', 'Book a table at Tablehop', 'Reserve a table on Tablehop'],
    desc: ['Book a table for 4 on Friday at 7:30pm at the Italian place near [ADDRESS]', 'Find and book a brunch table for 6 this Sunday'],
    steps: [S('navigate', 'Opened tablehop.com', null, '/'), S('search', 'Searched for the restaurant', 'Search', '/search'),
      S('click', 'Opened the restaurant page', 'Restaurant', '/r/:id'), S('select', 'Picked the date and party size', 'Date and guests', '/r/:id'),
      S('click', 'Chose a time slot', 'Time slot', '/r/:id/times'), S('type', "Entered the guest's details", 'Guest details', '/r/:id/book', 'personal'),
      S('click', "Clicked 'Complete booking'", 'Complete booking', '/r/:id/book')],
    dead: [[4, 0.35, S('click', "Clicked a greyed-out '19:30' slot", 'Greyed time slot', '/r/:id/times'), 'Slot was already taken']],
  },
  {
    site: 'streamly.tv', weight: 8, tags: ['Cancel Streamly subscription', 'Cancel my Streamly plan', 'Unsubscribe from Streamly'],
    desc: ['Cancel my streamly.tv subscription before it renews', 'Cancel the streaming trial for [EMAIL]'],
    steps: [S('navigate', 'Opened streamly.tv', null, '/'), S('type', 'Signed in', 'Sign in', '/login', 'credentials'),
      S('click', "Opened 'Account'", 'Account', '/account'), S('click', "Clicked 'Cancel membership'", 'Cancel membership', '/account/cancel'),
      S('click', "Clicked 'Finish cancellation'", 'Finish cancellation', '/account/cancel/confirm')],
    dead: [[3, 0.25, S('click', "Clicked 'Change plan' looking for cancel", 'Change plan', '/account/plan'), 'Only offers other plans']],
  },
  {
    site: 'parcelly.co', weight: 6, tags: ['Return an item to Parcelly', 'Return an item on Parcelly'],
    desc: ['Return the jacket from order [ACCOUNT] at parcelly.co'],
    steps: [S('navigate', 'Opened parcelly.co', null, '/'), S('click', "Opened 'Your orders'", 'Your orders', '/orders'),
      S('click', 'Opened the order', 'Order', '/orders/:id'), S('click', "Clicked 'Return item'", 'Return item', '/orders/:id/return'),
      S('select', 'Chose drop-off as the return method', 'Drop-off', '/orders/:id/return'), S('click', 'Printed the return label', 'Return label', '/orders/:id/return/label')],
    dead: [[3, 0.3, S('click', "Clicked 'Help' to start a return", 'Help', '/help'), 'Help page only links to FAQs']],
  },
  {
    site: 'skyfare.io', weight: 6, redesign: true, tags: ['Change a flight on Skyfare', 'Change my Skyfare flight'],
    desc: ['Change my skyfare.io flight to the day after, same time'],
    steps: [S('navigate', 'Opened skyfare.io', null, '/'), S('click', "Opened 'My trips'", 'My trips', '/trips'),
      S('click', 'Opened the booking', 'Booking', '/trips/:id'), S('click', "Clicked 'Change flight'", 'Change flight', '/trips/:id/change'),
      S('select', 'Picked the new date', 'New date', '/trips/:id/change'), S('click', 'Confirmed the change', 'Confirm change', '/trips/:id/change/confirm')],
    newSteps: [S('navigate', 'Opened skyfare.io', null, '/'), S('click', "Opened 'Manage booking'", 'Manage booking', '/manage'),
      S('type', 'Entered the booking reference', 'Booking reference', '/manage', 'personal'), S('click', "Clicked 'Modify trip'", 'Modify trip', '/manage/:id'),
      S('select', 'Picked the new date', 'New date', '/manage/:id/modify'), S('click', 'Confirmed the change', 'Confirm change', '/manage/:id/modify/confirm')],
    dead: [],
  },
  {
    site: 'cityparking.gov', weight: 3, blocked: true, tags: ['Pay a parking fine on Cityparking'],
    desc: ['Pay my parking fine at cityparking.gov, notice [ACCOUNT]'],
    steps: [S('navigate', 'Opened cityparking.gov', null, '/'), S('click', "Clicked 'Pay a fine'", 'Pay a fine', '/pay'),
      S('ask_human', 'Site terms do not allow automated agents; handed back', null, '/terms')],
    dead: [],
  },
  {
    site: 'giftbox.shop', weight: 4, spike: 5, tags: ['Buy a birthday gift on Giftbox', 'Buy birthday gift on Giftbox'],
    desc: ['Buy a birthday gift for my sister, around 40, delivered to [ADDRESS]'],
    steps: [S('navigate', 'Opened giftbox.shop', null, '/'), S('search', 'Searched for birthday gifts', 'Search', '/search'),
      S('click', 'Opened a gift', 'Product', '/p/:id'), S('click', "Clicked 'Add to basket'", 'Add to basket', '/p/:id'),
      S('click', 'Went to checkout', 'Checkout', '/checkout'), S('type', 'Paid', 'Card', '/checkout/payment', 'payment')],
    dead: [[4, 0.2, S('click', "Clicked 'Gift wrap' which reset the basket", 'Gift wrap', '/basket'), 'Basket emptied']],
  },
  {
    site: 'freshcart.co', weight: 6, tags: ['Order groceries from Freshcart', 'Order my groceries on Freshcart'],
    desc: ['Order the weekly groceries from my usual list for delivery to [ADDRESS]'],
    steps: [S('navigate', 'Opened freshcart.co', null, '/'), S('click', "Opened 'Favourites'", 'Favourites', '/favourites'),
      S('click', "Clicked 'Add all to basket'", 'Add all to basket', '/favourites'), S('select', 'Picked a delivery slot', 'Delivery slot', '/slots'),
      S('click', 'Went to checkout', 'Checkout', '/checkout'), S('type', 'Paid', 'Card', '/checkout/payment', 'payment')],
    dead: [],
  },
  {
    site: 'staynest.com', weight: 5, spike: 1.8, tags: ['Book a hotel on Staynest', 'Book a hotel room on Staynest'],
    desc: ['Book a hotel near the conference venue for 3 nights'],
    steps: [S('navigate', 'Opened staynest.com', null, '/'), S('search', 'Searched the city and dates', 'Search', '/search'),
      S('click', 'Opened a hotel', 'Hotel', '/h/:id'), S('select', 'Picked a room', 'Room', '/h/:id'),
      S('type', "Entered the guest's details", 'Guest details', '/h/:id/book', 'personal'), S('type', 'Paid', 'Card', '/h/:id/pay', 'payment')],
    dead: [],
  },
  {
    site: 'ticketloop.com', weight: 3, tags: ['Buy concert tickets on Ticketloop'],
    desc: ['Buy 2 tickets for the Saturday concert, under 80 each'],
    steps: [S('navigate', 'Opened ticketloop.com', null, '/'), S('search', 'Searched for the concert', 'Search', '/search'),
      S('click', 'Opened the event', 'Event', '/e/:id'), S('select', 'Picked two seats', 'Seats', '/e/:id/seats'),
      S('type', 'Paid', 'Card', '/checkout', 'payment')],
    dead: [],
  },
  {
    site: 'expensely.io', weight: 4, tags: ['Submit an expense report on Expensely', 'File an expense report on Expensely'],
    desc: ['File an expense report for last week’s receipts'],
    steps: [S('navigate', 'Opened expensely.io', null, '/'), S('click', "Clicked 'New report'", 'New report', '/reports/new'),
      S('click', 'Uploaded the receipts', 'Upload', '/reports/new'), S('select', 'Picked the cost centre', 'Cost centre', '/reports/new'),
      S('click', "Clicked 'Submit'", 'Submit', '/reports/new')],
    dead: [],
  },
  { site: null, weight: 4, tags: ['Summarise a PDF report'], desc: ['Summarise this 40-page PDF report into 5 bullet points'],
    steps: [S('tool', 'Read the PDF', null, null), S('think', 'Drafted the summary', null, null)], dead: [] },
  { site: null, weight: 3, spike: 0.5, tags: ['Research running shoes'], desc: ['Research the best running shoes for flat feet'],
    steps: [S('search', 'Searched for reviews', null, null), S('read', 'Read three reviews', null, null), S('think', 'Wrote a shortlist', null, null)], dead: [] },
];
// One-off tasks: a single person each, so their names stay private ("Emailed something").
const ONE_OFF = [
  ['Email [NAME] about the school trip form', 'Email the teacher about the school trip form'],
  ['Fix the failing payments test in our repo', 'Fix the payments test in the billing repo'],
  ['Find a babysitter for Saturday near [ADDRESS]', 'Find a babysitter near home'],
];
const REDESIGN_AT = TODAY_START - 5 * DAY + 9 * HOUR;
const NEW_PATH_FROM = TODAY_START - 2 * DAY;

// ---------------------------------------------------------------------------- trace generation
function isoWeekStart(ms) { const d = new Date(ms); const day = d.getUTCDay() || 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - (day - 1) * DAY; }
const LAST_WEEK_START = isoWeekStart(NOW) - 7 * DAY;

function buildTrace(sc, agent, at, recipeId) {
  const s = sc.redesign && at > REDESIGN_AT;
  const newPath = s && at > NEW_PATH_FROM && chance(0.85);
  let outcome = chance(MODEL_P[agent.model]) ? 'done' : chance(0.45) ? 'handed_back' : 'failed';
  let reason = null, blocked = false;
  if (sc.blocked) { outcome = 'handed_back'; reason = 'Site terms do not allow automated agents.'; blocked = true; }
  if (s && !newPath) { outcome = chance(0.1) ? 'handed_back' : 'failed'; }
  const script = newPath ? sc.newSteps : sc.steps;
  const steps = [];
  const failAt = outcome === 'failed' ? (s && !newPath ? 3 : ri(1, script.length - 1)) : -1;
  for (let k = 0; k < script.length; k++) {
    for (const [before, p, step, err] of sc.dead) if (k === before && chance(p)) steps.push({ ...step, result: 'fail', error: err });
    const st = script[k];
    if (k === failAt) {
      steps.push({ ...st, result: 'fail', error: s && !newPath ? "'Change flight' button missing after the site redesign" : 'Page did not respond after several tries' });
      reason = reason ?? 'Got stuck on the site';
      break;
    }
    if (outcome === 'handed_back' && !sc.blocked && k === script.length - 1) {
      steps.push({ type: 'ask_human', action: 'Asked the human to decide before continuing', path: st.path });
      reason = 'Needed a choice only the human can make';
      break;
    }
    steps.push({ ...st, result: chance(0.06) ? 'retry' : 'ok' });
  }
  const host = sc.site ? `https://www.${sc.site}` : null;
  const duration = Math.max(30, steps.length * ri(15, 45) + ri(5, 60));
  const useTag = chance(0.85);
  return {
    schema: 'wisptrace.trace/v1',
    client: { name: 'fixture', version: '0', masked: true },
    task: {
      description: pick(sc.desc),
      ...(useTag ? { tag: pick(sc.tags) } : {}),
      ...(sc.site ? { sites: [sc.site] } : {}),
    },
    agent: { app: agent.app, model: agent.model },
    duration_s: duration,
    outcome: { status: outcome, ...(reason && outcome !== 'done' ? { reason } : {}), ...(blocked ? { blocked_by_site: true } : {}) },
    steps: steps.map(x => ({
      type: x.type, action: x.action, ...(x.target ? { target: x.target } : {}),
      ...(host && x.path ? { url: host + x.path.replace(/:id/g, String(ri(1000, 99999))) } : {}),
      result: x.result ?? 'ok', ...(x.error ? { error: x.error } : {}), ...(x.sensitive ? { sensitive: x.sensitive } : {}),
    })),
    usage: { cost_usd: Math.round(steps.length * COST[agent.model] * (0.6 + rnd()) * 10000) / 10000 },
    ...(recipeId && outcome === 'done' ? { recipe_id: recipeId } : {}),
  };
}

function scenarioFor(at) {
  const weights = SCEN.map(sc => sc.weight * (at >= LAST_WEEK_START && at < LAST_WEEK_START + 7 * DAY ? sc.spike ?? 1 : 1));
  let x = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < SCEN.length; i++) { x -= weights[i]; if (x <= 0) return SCEN[i]; }
  return SCEN[0];
}

function slots(fromDay, toDay) {
  const out = [];
  const totalW = AGENTS.reduce((n, a) => n + a[3], 0);
  for (let d = fromDay; d >= toDay; d--) {
    const dayStart = TODAY_START - d * DAY;
    const dow = new Date(dayStart).getUTCDay();
    const growth = 0.6 + 0.4 * ((NDAYS - d) / NDAYS);
    const perDay = Math.round(70 * growth * (dow === 0 || dow === 6 ? 0.7 : 1));
    const end = d === 0 ? NOW - 2 * MIN : dayStart + DAY;
    for (let n = 0; n < perDay * (d === 0 ? (NOW - dayStart) / DAY : 1); n++) {
      let x = rnd() * totalW, k = 0;
      while (x > AGENTS[k][3]) x -= AGENTS[k++][3];
      out.push({ agent: k, at: Math.floor(dayStart + rnd() * (end - dayStart)) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------- run
console.log(`fixture -> ${BASE} (local demo data)`);
const agents = [];
for (const [name, app, model, weight, handle, platform] of AGENTS) {
  if (platform === 'seed') {
    const r = await call('POST', '/api/admin/seed-agents', { name, app, model }, ADMIN);
    agents.push({ name, app, model, weight, key: r.api_key });
  } else {
    const r = await call('POST', '/api/v1/agents/register', { name, app, model });
    await call('POST', '/api/admin/dev/claim', { name: r.agent.name, handle }, ADMIN);
    agents.push({ name: r.agent.name, app, model, weight, key: r.api_key });
  }
}
for (const [name, app, model] of UNCLAIMED) await call('POST', '/api/v1/agents/register', { name, app, model });
console.log(`  ${agents.length} claimed agents, ${UNCLAIMED.length} unclaimed`);

const backfill = (agent, at, trace) => call('POST', '/api/admin/dev/backfill', { agent_name: agent.name, occurred_at: at, trace }, ADMIN);

// Phase A: history, no recipes to cite yet.
const histA = slots(NDAYS - 1, PHASE_B_DAYS);
await pool(histA, 6, s => backfill(agents[s.agent], s.at, buildTrace(scenarioFor(s.at), agents[s.agent], s.at, null)));
// One-off tasks, one person each.
for (const [i, [desc, tag]] of ONE_OFF.entries()) {
  const a = agents[(i * 5 + 2) % agents.length];
  await backfill(a, NOW - (3 + i) * DAY, { schema: 'wisptrace.trace/v1', task: { description: desc, tag }, outcome: { status: 'done' }, duration_s: 300, steps: [{ action: 'Did it', type: 'other' }] });
}
const runRecipes = async () => { for (let i = 0; i < 12; i++) { const r = await call('POST', '/api/admin/run-jobs', { jobs: ['recipes'] }, ADMIN); if (!r.jobs?.recipes?.result?.groups) break; } };
await runRecipes();
console.log(`  phase A: ${histA.length} traces, recipes built`);

// Phase B: the last days, where many agents look the recipe up first and cite it (upvotes for its builders).
const recipeFor = new Map();
for (const sc of SCEN) {
  if (!sc.site) continue;
  const r = await call('GET', `/api/v1/recipes?task=${encodeURIComponent(sc.tags[0])}&site=${sc.site}`);
  if (r.recipes?.[0]) recipeFor.set(sc, r.recipes[0].id);
}
const histB = slots(PHASE_B_DAYS - 1, 0);
await pool(histB, 6, s => {
  const sc = scenarioFor(s.at);
  const cite = recipeFor.get(sc) && chance(0.55) ? recipeFor.get(sc) : null;
  return backfill(agents[s.agent], s.at, buildTrace(sc, agents[s.agent], s.at, cite));
});
await runRecipes();
console.log(`  phase B: ${histB.length} traces (${recipeFor.size} recipes cited)`);

const lastWeek = (() => { const d = new Date(LAST_WEEK_START + 3 * DAY); const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - (d.getUTCDay() || 7))); const y = day.getUTCFullYear(); const w = Math.ceil(((day - Date.UTC(y, 0, 1)) / DAY + 1) / 7); return `${y}-W${String(w).padStart(2, '0')}`; })();
const jobs = await call('POST', '/api/admin/run-jobs', { jobs: ['trends', 'awards', 'snapshots'], week: lastWeek }, ADMIN);
console.log(`  trends + awards: ${JSON.stringify({ trends: jobs.jobs?.trends?.result, awards: jobs.jobs?.awards?.result })}`);
const sum = await call('GET', '/api/admin/summary', undefined, ADMIN);
console.log(`  summary: ${JSON.stringify({ traces: sum.traces, recipes: sum.recipes, tasks: sum.tasks })}`);

const credsSql = opt('creds-sql');
if (credsSql) {
  writeFileSync(credsSql, [
    `UPDATE agents SET api_key_hash = '${sha256('wt_devQuietfox7ApiKey000000000000')}', api_key_prefix = 'wt_devQuie',`,
    `  owner_token_hash = '${sha256('wto_devQuietfox7OwnerToken0000000000')}' WHERE name = 'quietfox-7';`,
    `UPDATE agents SET claim_code = 'ne7-test' WHERE name = 'newbie-owl';`,
  ].join('\n'));
}
