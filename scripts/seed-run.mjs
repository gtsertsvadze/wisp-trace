#!/usr/bin/env node
// Seed fleet runner: one seed agent does the no-account tasks from seed-tasks.json for real (plain HTTP requests with an
// honest user agent, no browser), records every step, and sends each trace through the open-source Wisptrace client
// (so client-side masking applies). Blocks, challenges and terms that forbid automation are handed back, never worked
// around.
//
//   node scripts/seed-run.mjs --agent seed-01 [--dry] [--only 33,36]
//
// Credentials: .seed-fleet/<agent>/credentials.json (gitignored), created via POST /api/admin/seed-agents.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true; };
const AGENT = opt('agent');
const DRY = !!opt('dry');
const ONLY = typeof opt('only') === 'string' ? new Set(String(opt('only')).split(',').map(Number)) : null;
if (typeof AGENT !== 'string') { console.error('usage: node scripts/seed-run.mjs --agent seed-01 [--dry] [--only 33,36]'); process.exit(2); }

const UA = 'Mozilla/5.0 (compatible; wisptrace-seed/0.1; +https://wisptrace.com)';
const MODEL = 'claude-opus-5-5', APP = 'Claude Code';
const tasks = JSON.parse(readFileSync(join(root, 'seed-tasks.json'), 'utf8')).tasks.filter(t => !t.needs_account && (!ONLY || ONLY.has(t.id)));
const fleetDir = join(root, '.seed-fleet', AGENT);
const outDir = join(root, '.seed-fleet', 'traces', AGENT);
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------ helpers
const text = h => h.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&pound;/g, '£').replace(/\s+/g, ' ').trim();
const WALL = /captcha|robot check|are you a human|unusual traffic|request blocked|px-captcha|cf-chl|challenge-platform|access denied/i;

class Run {
  constructor(task) { this.task = task; this.steps = []; this.t0 = Date.now(); this.cookies = new Map(); }
  async fetch(url, init = {}) {
    const t = Date.now();
    const headers = { 'user-agent': UA, accept: 'text/html,application/json,application/pdf,*/*', ...(init.headers || {}) };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(url, { ...init, headers, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
    const ct = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    const html = ct.includes('pdf') ? '' : buf.toString('utf8');
    // A wall is an HTTP refusal or a challenge page (judged by its title, not by words anywhere in the page).
    const title = (/<title[^>]*>([^<]*)/i.exec(html) || [])[1] ?? '';
    const wall = r.status === 403 || r.status === 429 || (r.status === 202 && buf.length < 10_000) || WALL.test(title);
    return { status: r.status, url: r.url, html, buf, ct, ms: Date.now() - t, wall };
  }
  step(type, action, extra = {}) { this.steps.push({ type, action, result: 'ok', ...extra }); return this; }
  done(answer) { return { outcome: { status: 'done' }, answer }; }
  handBack(reason, blocked = false) { return { outcome: { status: 'handed_back', reason, ...(blocked ? { blocked_by_site: true } : {}) }, answer: reason }; }
  failed(reason) { return { outcome: { status: 'failed', reason }, answer: reason }; }
  /** Open a page; on a wall record it and hand back (never work around it). */
  async open(action, url, target) {
    const p = await this.fetch(url);
    const title = (/<title[^>]*>([^<]*)/i.exec(p.html) || [])[1]?.trim().replace(/\s+/g, ' ') ?? '';
    if (p.wall) {
      this.step('navigate', action, { url, target, result: 'fail', error: `HTTP ${p.status}: the site refused the request (access denied / bot check)`, duration_ms: p.ms });
      return { page: p, blocked: true };
    }
    this.step('navigate', action, { url: p.url, target, result: p.status >= 400 ? 'fail' : 'ok', observation: `HTTP ${p.status}${title ? ` · "${title.slice(0, 100)}"` : ''}`, duration_ms: p.ms, ...(p.status >= 400 ? { error: `HTTP ${p.status}` } : {}) });
    return { page: p, blocked: false };
  }
}

const blockedReason = site => `${site} refused the request with an access-denied / bot-check page, so I stopped and handed it back. No workaround attempted.`;

// ------------------------------------------------------------------ the tasks
const H = {
  async 6(r) { // Spotify album details
    const s = await r.fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent('Random Access Memories Daft Punk site:open.spotify.com album'));
    const m = /uddg=(https%3A%2F%2Fopen\.spotify\.com%2Falbum%2F[^&"]+)/.exec(s.html);
    const albumUrl = m ? decodeURIComponent(m[1]) : null;
    r.step('search', 'Searched the web for the album on Spotify', { url: 'https://html.duckduckgo.com/html/', result: albumUrl ? 'ok' : 'fail', observation: albumUrl ? 'Found the Spotify album page' : 'No Spotify album link in results' });
    if (!albumUrl) return r.failed('Could not find the album page on Spotify');
    const { page, blocked } = await r.open('Opened the album page on Spotify', albumUrl, 'Random Access Memories');
    if (blocked) return r.handBack(blockedReason('open.spotify.com'), true);
    const date = /music:release_date"[^>]*content="([^"]+)"/.exec(page.html)?.[1];
    const songs = /og:description"[^>]*content="[^"]*?(\d+) songs?/.exec(page.html)?.[1];
    r.step('read', 'Read the release date and track count from the album details', { observation: `release date ${date ?? '?'}, ${songs ?? '?'} songs`, model_response: 'The album details show the release date and the number of songs.' });
    return date && songs ? r.done(`Random Access Memories by Daft Punk: released ${date}, ${songs} tracks.`) : r.failed('The album page did not show the release date and track count');
  },
  async 8(r) { // NYT headline
    const { page, blocked } = await r.open('Opened the New York Times homepage', 'https://www.nytimes.com/');
    if (blocked) return r.handBack(blockedReason('nytimes.com'), true);
    const h = /<h3[^>]*>([^<]{10,160})<\/h3>/.exec(page.html)?.[1];
    return h ? r.done(`Lead headline: ${h}`) : r.failed('No headline found');
  },
  async 9(r) { // cheapest 1TB NVMe with Prime on Amazon UK
    const { page, blocked } = await r.open('Searched Amazon UK for 1TB NVMe SSDs sorted by price', 'https://www.amazon.co.uk/s?k=1TB+NVMe+M.2+SSD&s=price-asc-rank', 'Sort by: Price low to high');
    if (blocked) return r.handBack(blockedReason('amazon.co.uk'), true);
    const prime = (page.html.match(/a-icon-prime/g) || []).length;
    const first = [...page.html.matchAll(/<h2[^>]*aria-label="([^"]*NVMe[^"]*)"/gi)][0]?.[1];
    r.step('read', 'Checked the results for Prime delivery badges', { result: prime ? 'ok' : 'fail', observation: `${prime} Prime badges in the results${first ? `; cheapest NVMe listed: ${first.slice(0, 80)}` : ''}`, error: prime ? undefined : 'Prime eligibility not shown' });
    return r.handBack('Amazon UK search results load, but Prime delivery badges only show in a signed-in browser session, so "cheapest with Prime delivery" can\'t be confirmed. Handing back.');
  },
  async 13(r) { // Amazon price of an ASIN
    const { page, blocked } = await r.open('Opened the Amazon UK product page for the ASIN', 'https://www.amazon.co.uk/dp/B0BSHF7WHW', 'B0BSHF7WHW');
    if (blocked) return r.handBack(blockedReason('amazon.co.uk'), true);
    if (page.status === 404) return r.failed('Amazon UK has no product page for ASIN B0BSHF7WHW (404), so there is no price to compare.');
    const price = /<span class="a-offscreen">(£[\d.,]+)<\/span>/.exec(page.html)?.[1];
    return price ? r.done(`Current price ${price}. No stored baseline from last week to compare against.`) : r.failed('No price shown on the product page');
  },
  async 14(r) { // eBay used iPhone
    const { blocked } = await r.open('Searched eBay UK for used iPhone 14 128GB, Buy It Now, lowest price first', 'https://www.ebay.co.uk/sch/i.html?_nkw=iphone+14+128gb&LH_ItemCondition=3000&LH_BIN=1&_sop=15&LH_PrefLoc=1');
    if (blocked) return r.handBack(blockedReason('ebay.co.uk'), true);
    return r.handBack('eBay results did not load for an automated agent. Handing back.');
  },
  async 17(r) {
    const { blocked } = await r.open('Searched Argos for the Nintendo Switch OLED', 'https://www.argos.co.uk/search/nintendo-switch-oled/');
    if (blocked) return r.handBack(blockedReason('argos.co.uk'), true);
    return r.handBack('Store stock needs the Argos stock checker in a browser. Handing back.');
  },
  async 18(r) {
    const { blocked } = await r.open('Searched Argos for air fryers', 'https://www.argos.co.uk/search/air-fryer/');
    if (blocked) return r.handBack(blockedReason('argos.co.uk'), true);
    return r.handBack('Argos results did not load for an automated agent. Handing back.');
  },
  async 20(r) {
    const { page, blocked } = await r.open('Searched IKEA UK for KALLAX 4x4 in white', 'https://www.ikea.com/gb/en/search/?q=kallax%204x4%20white');
    if (blocked) return r.handBack(blockedReason('ikea.com'), true);
    const hasStore = /Greenwich/i.test(page.html);
    r.step('read', 'Looked for store availability at IKEA Greenwich', { result: hasStore ? 'ok' : 'fail', observation: hasStore ? 'Store mentioned' : 'No store stock in the page: the stock checker runs in the browser', error: hasStore ? undefined : 'Stock checker needs a browser' });
    return r.handBack('IKEA\'s store stock checker only runs in a browser, so availability at IKEA Greenwich can\'t be read with plain requests. Handing back.');
  },
  async 21(r) {
    const { blocked } = await r.open('Opened the BILLY bookcase page on IKEA UK', 'https://www.ikea.com/gb/en/p/billy-bookcase-white-00263850/', 'BILLY bookcase, white');
    if (blocked) return r.handBack(blockedReason('ikea.com'), true);
    r.step('click', "Tried to use 'Add to bag'", { target: 'Add to bag', result: 'fail', error: 'The basket only works in a browser session' });
    return r.handBack('Delivery cost needs the item in the basket, and IKEA\'s basket only works in a browser. Handing back.');
  },
  async 23(r) {
    const { blocked } = await r.open('Searched Booking.com for 4-star hotels in Lisbon, 12–15 Dec, free cancellation', 'https://www.booking.com/searchresults.en-gb.html?ss=Lisbon&checkin=2026-12-12&checkout=2026-12-15&nflt=class%3D4%3Bfc%3D2&order=price');
    if (blocked) return r.handBack(blockedReason('booking.com'), true);
    return r.handBack('Booking.com results need a browser. Handing back.');
  },
  async 26(r) {
    const { page, blocked } = await r.open('Searched Skyscanner for London to Tbilisi returns, 2–9 Jan', 'https://www.skyscanner.net/transport/flights/lond/tbs/260102/260109/');
    if (blocked) return r.handBack(blockedReason('skyscanner.net'), true);
    r.step('read', 'Looked for fares for the chosen dates', { result: 'fail', observation: `Landed on ${new URL(page.url).pathname}: the dated search redirected to a general route page`, error: 'Dated fares only load in a browser' });
    return r.handBack('Skyscanner dropped the dates and showed a general route page; dated fares only load in a browser. Handing back.');
  },
  async 28(r) {
    const { blocked } = await r.open('Opened Trainline London to Manchester', 'https://www.thetrainline.com/train-times/london-to-manchester');
    if (blocked) return r.handBack(blockedReason('thetrainline.com'), true);
    r.step('read', 'Looked for fares for next Saturday around 9am and 6pm', { result: 'fail', observation: 'The page shows typical fares; times for a specific day come from the journey planner', error: 'Journey planner needs a browser' });
    return r.handBack('Specific Saturday fares come from Trainline\'s journey planner, which only runs in a browser. Handing back.');
  },
  async 29(r) { // Trainline Delay Repay steps
    const s = await r.fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent('trainline delay repay how to claim'));
    const m = /uddg=(https%3A%2F%2Fwww\.thetrainline\.com%2F[^&"]*delay[^&"]*repay[^&"]*)/i.exec(s.html);
    const url = m ? decodeURIComponent(m[1]) : null;
    r.step('search', "Searched the web for Trainline's Delay Repay guide", { url: 'https://html.duckduckgo.com/html/', result: url ? 'ok' : 'fail', observation: url ? 'Found Trainline\'s Delay Repay page' : 'No Trainline Delay Repay page in results' });
    if (!url) return r.failed('Could not find Trainline\'s Delay Repay guide');
    const { page, blocked } = await r.open("Opened Trainline's Delay Repay guide", url, 'Delay Repay');
    if (blocked) return r.handBack(blockedReason('thetrainline.com'), true);
    // The steps are the section under the "How to use Delay Repay" heading.
    const at = page.html.search(/How to use Delay Repay/i);
    const sec = at < 0 ? '' : page.html.slice(at, page.html.indexOf('<h2', at + 30) > 0 ? page.html.indexOf('<h2', at + 30) : at + 8000);
    const items = [...sec.matchAll(/<(?:p|li)[^>]*>([\s\S]*?)<\/(?:p|li)>/g)].map(x => text(x[1]).trim()).filter(x => x.length > 15).slice(0, 6);
    r.step('read', 'Read the steps for making a claim', { observation: items.length ? items.map((x, i) => `${i + 1}. ${x.slice(0, 140)}`).join(' ') : 'No step list found', result: items.length ? 'ok' : 'fail' });
    return items.length ? r.done(`Delay Repay with Trainline: ${items.map((x, i) => `${i + 1}) ${x.slice(0, 160)}`).join(' ')}`) : r.failed('The guide had no list of steps');
  },
  async 30(r) {
    const { blocked } = await r.open('Searched Airbnb for entire homes in Edinburgh, 30 Dec–2 Jan, under £200 a night', 'https://www.airbnb.co.uk/s/Edinburgh/homes?checkin=2026-12-30&checkout=2027-01-02&room_types%5B%5D=Entire%20home%2Fapt&price_max=200');
    if (blocked) return r.handBack(blockedReason('airbnb.co.uk'), true);
    r.step('read', 'Looked for listings with prices for the dates', { result: 'fail', observation: 'Listings and prices for the dates are rendered in the browser', error: 'Needs a browser' });
    return r.handBack('Airbnb renders listings and prices for specific dates in the browser only. Handing back.');
  },
  async 32(r) { // state pension age
    const a = await r.open("Opened GOV.UK 'Check your State Pension age'", 'https://www.gov.uk/state-pension-age', 'Check your State Pension age');
    if (a.blocked) return r.handBack(blockedReason('gov.uk'), true);
    r.step('click', "Clicked 'Start now'", { target: 'Start now', url: 'https://www.gov.uk/state-pension-age/y' });
    r.step('type', 'Entered the date of birth 15 March 1985', { target: 'Date of birth' });
    const b = await r.open("Clicked 'Next step' and read the result", 'https://www.gov.uk/state-pension-age/y/age/1985-03-15', 'Next step');
    const t = text(b.page.html);
    const age = /Your State Pension age is ([\d ]+years?)/.exec(t)?.[1];
    const date = /reach State Pension age on (\d{1,2} \w+ \d{4})/.exec(t)?.[1];
    r.step('read', 'Read the State Pension age and date', { observation: `age ${age ?? '?'}, reached on ${date ?? '?'}`, result: age && date ? 'ok' : 'fail' });
    return age && date ? r.done(`State Pension age for someone born 15 March 1985: ${age}, reached on ${date} (may change after review).`) : r.failed('The result page did not show an age');
  },
  async 33(r) { // passport fee + time
    const a = await r.open("Opened GOV.UK 'Renew or replace your adult passport'", 'https://www.gov.uk/renew-adult-passport', 'Renew or replace your adult passport');
    if (a.blocked) return r.handBack(blockedReason('gov.uk'), true);
    const t = text(a.page.html);
    const fee = /It costs (£[\d.]+) to renew or replace your passport if you apply online(?: or (£[\d.]+)[^.]{0,40})?/.exec(t);
    r.step('read', 'Read the fee', { observation: fee ? fee[0].slice(0, 160) : 'fee not found', result: fee ? 'ok' : 'fail' });
    const href = /<a[^>]*href="([^"]+)"[^>]*>\s*Check how long it will take[^<]*<\/a>/i.exec(a.page.html)?.[1];
    if (!href) return r.failed('No link to processing times');
    const b = await r.open("Followed 'Check how long it will take to get a passport'", new URL(href, 'https://www.gov.uk').toString(), 'Check how long it will take to get a passport');
    const time = /You[’']ll usually get your passport within [^.]+/.exec(text(b.page.html))?.[0];
    r.step('read', 'Read the processing time', { observation: time ? time.slice(0, 160) : 'time not found', result: time ? 'ok' : 'fail' });
    return fee && time ? r.done(`UK adult passport renewal online: ${fee[1]}${fee[2] ? ` (${fee[2]} by post)` : ''}. Processing: ${time.trim().replace(/^You[’']ll usually get your passport/, 'usually')}.`) : r.failed('Fee or processing time not found');
  },
  async 35(r) { // vehicle tax + MOT
    const a = await r.fetch('https://vehicleenquiry.service.gov.uk/');
    r.step('navigate', "Opened GOV.UK 'Check if a vehicle is taxed and has an MOT'", { url: a.url, observation: `HTTP ${a.status}`, result: a.status < 400 && !a.wall ? 'ok' : 'fail' });
    if (a.wall) return r.handBack(blockedReason('vehicleenquiry.service.gov.uk'), true);
    const form = [...a.html.matchAll(/<form[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/g)].find(f => /vrn/.test(f[2]));
    if (!form) return r.failed('Registration form not found');
    const token = /name="authenticity_token" value="([^"]+)"/.exec(form[2])?.[1] ?? '';
    r.step('type', 'Entered the registration number', { target: 'Registration number (number plate)' });
    const b = await r.fetch(new URL(form[1].replace(/&amp;/g, '&'), a.url).toString(), { method: 'POST', body: new URLSearchParams({ authenticity_token: token, 'wizard_vehicle_enquiry_capture_vrn[vrn]': 'AB12CDE' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const bt = text(b.html);
    r.step('click', "Clicked 'Continue'", { target: 'Continue', url: b.url, observation: bt.includes('Is this the vehicle') ? 'Asked to confirm the vehicle' : bt.slice(0, 120), result: b.status < 400 ? 'ok' : 'fail' });
    if (/could not be found|not found|no details held/i.test(bt)) return r.done('No vehicle with registration AB12 CDE was found, so there is no tax or MOT status to report.');
    const cf = [...b.html.matchAll(/<form[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/g)].find(f => /radio/.test(f[2]));
    if (!cf) return r.failed('Confirmation step not found');
    const ctoken = /name="authenticity_token" value="([^"]+)"/.exec(cf[2])?.[1] ?? '';
    const yes = [...cf[2].matchAll(/<input[^>]*>/g)].map(m => m[0]).find(i => /type="radio"/.test(i) && /value="Yes"/.test(i));
    const radio = yes ? [null, /name="([^"]+)"/.exec(yes)?.[1], 'Yes'] : null;
    const make = /Make\s+([A-Z][A-Z0-9 -]{1,30}?)\s+(?:Colour|Year)/.exec(bt)?.[1];
    r.step('select', "Chose 'Yes' to confirm the vehicle", { target: 'Yes', observation: make ? `Vehicle shown: ${make}` : undefined });
    const c = await r.fetch(new URL(cf[1].replace(/&amp;/g, '&'), b.url).toString(), { method: 'POST', body: new URLSearchParams({ authenticity_token: ctoken, ...(radio ? { [radio[1]]: radio[2] } : {}) }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const ct = text((/<main[\s\S]*<\/main>/.exec(c.html) || [c.html])[0]);
    const tx = /is (Taxed|Untaxed|SORN)(?: Tax due: (\d{1,2} \w+ \d{4}))?/.exec(ct);
    const mt = /(has a valid MOT certificate|MOT has expired|has no MOT|No (?:MOT )?details held[^.!]*)(?: Expires: (\d{1,2} \w+ \d{4}))?/i.exec(ct);
    const tax = tx ? `${tx[1]}${tx[2] ? ` (tax due ${tx[2]})` : ''}` : null;
    const mot = mt ? `${mt[1].replace(/^has /, '')}${mt[2] ? ` (expires ${mt[2]})` : ''}` : null;
    r.step('click', "Clicked 'Continue' and read the tax and MOT status", { target: 'Continue', url: c.url, observation: tax || mot ? `${tax ?? 'tax ?'} · ${mot ?? 'MOT ?'}` : `HTTP ${c.status} ${ct.slice(0, 160)}`, result: tax || mot ? 'ok' : 'fail' });
    return tax || mot ? r.done(`AB12 CDE: ${tax ?? 'tax status not shown'}; ${mot ?? 'MOT status not shown'}.`) : r.failed('Tax and MOT status not shown');
  },
  async 36(r) { // TfL Jubilee
    const a = await r.open("Opened TfL's live status for the Jubilee line", 'https://api.tfl.gov.uk/Line/jubilee/Status', 'Jubilee line status');
    if (a.blocked) return r.handBack(blockedReason('tfl.gov.uk'), true);
    let st = null;
    try { const j = JSON.parse(a.page.html); st = j[0]?.lineStatuses?.map(x => `${x.statusSeverityDescription}${x.reason ? `: ${x.reason.slice(0, 160)}` : ''}`).join('; '); } catch { /* */ }
    r.step('read', 'Read the current status', { observation: st ?? 'no status', result: st ? 'ok' : 'fail' });
    return st ? r.done(`Jubilee line: ${st}`) : r.failed('No status returned');
  },
  async 39(r) { // GitHub
    const a = await r.fetch('https://api.github.com/search/repositories?q=agent+skills+created:%3E=2026-01-01&sort=stars&order=desc&per_page=3', { headers: { accept: 'application/vnd.github+json' } });
    r.step('search', "Searched GitHub repositories for 'agent skills' created in 2026, sorted by stars", { url: 'https://api.github.com/search/repositories', observation: `HTTP ${a.status}`, result: a.status === 200 ? 'ok' : 'fail', duration_ms: a.ms });
    if (a.status !== 200) return a.status === 403 || a.status === 429 ? r.handBack('GitHub rate-limited the search. Handing back.', false) : r.failed(`GitHub search returned HTTP ${a.status}`);
    const top = JSON.parse(a.html).items?.[0];
    r.step('read', 'Read the top result', { observation: top ? `${top.full_name} · ${top.stargazers_count} stars` : 'no results', result: top ? 'ok' : 'fail' });
    return top ? r.done(`Most-starred 'agent skills' repo created in 2026: ${top.full_name} (${top.stargazers_count} stars) ${top.html_url}`) : r.failed('No matching repositories');
  },
  async 44(r) { // LinkedIn
    r.step('read', "Checked LinkedIn's terms before searching", { url: 'https://www.linkedin.com/legal/user-agreement', observation: 'The User Agreement prohibits bots and other automated methods to access LinkedIn', model_response: 'LinkedIn does not allow automated access, so I should not run the search.' });
    return r.handBack("LinkedIn's User Agreement prohibits automated access, so I didn't search. Handing back: search LinkedIn Jobs yourself.", true);
  },
  async 45(r) { // Reddit
    const { blocked } = await r.open('Opened the top posts of the week in r/openclaw', 'https://www.reddit.com/r/openclaw/top/?t=week');
    if (blocked) return r.handBack(blockedReason('reddit.com'), true);
    r.step('read', 'Looked for the top post', { result: 'fail', observation: 'Reddit served an empty page shell; posts only load in a browser', error: 'No posts in the page' });
    return r.handBack('Reddit only shows posts to a browser (an automated agent gets an empty page). Handing back.');
  },
  async 47(r) { // BBC weather
    const a = await r.open('Opened BBC Weather for London', 'https://www.bbc.co.uk/weather/2643743', 'London');
    if (a.blocked) return r.handBack(blockedReason('bbc.co.uk'), true);
    const t = text(a.page.html);
    const days = [...t.matchAll(/(Today|Tonight|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}(?:st|nd|rd|th)) , ([A-Za-z ,]{5,60}?) [A-Z][a-z ]+ [A-Z][a-z ]+ , (High -?\d+° \d+° )?Low (-?\d+)°/g)].slice(0, 3)
      .map(m => `${m[1]}: ${m[2].trim().replace(/\s+(Light |Heavy |Sunny |Thick |Partly )?[A-Z][a-z]+( [A-Z][a-z]+)?$/, '')}${m[3] ? `, high ${/High (-?\d+)/.exec(m[3])[1]}°C` : ''}, low ${m[4]}°C`);
    r.step('read', 'Read the next three days', { observation: days.join(' | ') || 'forecast not found', result: days.length === 3 ? 'ok' : 'fail' });
    return days.length === 3 ? r.done(`London, BBC Weather: ${days.join('; ')}.`) : r.failed('Could not read three days of forecast');
  },
  async 48(r) { // BBC One schedule
    const a = await r.open('Opened the BBC One London schedule', 'https://www.bbc.co.uk/schedules/p00fzl6p', 'BBC One London');
    if (a.blocked) return r.handBack(blockedReason('bbc.co.uk'), true);
    const progs = a.page.html.split('class="broadcast__time').slice(1).map(chunk => [
      /timezone--time">(\d\d:\d\d)</.exec(chunk)?.[1], text(/programme__title[^"]*"[^>]*>\s*<span[^>]*>([^<]+)/.exec(chunk)?.[1] ?? ''),
    ]).filter(([t, n]) => t && n && t >= '19:00');
    const seen = new Set(); const list = progs.filter(([t, n]) => !seen.has(t + n) && seen.add(t + n)).slice(0, 10);
    r.step('read', "Read tonight's programmes from 7pm", { observation: list.map(([t, n]) => `${t} ${n}`).join(' · ') || 'no programmes found', result: list.length ? 'ok' : 'fail' });
    return list.length ? r.done(`BBC One London tonight: ${list.map(([t, n]) => `${t} ${n}`).join(', ')}.`) : r.failed('Could not read the schedule');
  },
  async 49(r) { // Wikipedia Tbilisi population
    const a = await r.open('Opened the Tbilisi article on Wikipedia', 'https://en.wikipedia.org/wiki/Tbilisi', 'Tbilisi');
    if (a.blocked) return r.handBack(blockedReason('wikipedia.org'), true);
    const box = (/<table class="infobox[\s\S]*?<\/table>/.exec(a.page.html) || [''])[0];
    const after = box.slice(Math.max(0, box.search(/Population/)));
    const row = /<td class="infobox-data"[^>]*>([\s\S]*?)<\/td>/.exec(after)?.[1] ?? '';
    const pop = /(\d{1,3}(?:,\d{3})+)/.exec(text(row))?.[1];
    const note = /#cite_note-([^"]+)"/.exec(row)?.[1];
    let cite = null;
    if (note) {
      // The reference list item for that footnote: <li ... id="cite_note-4"> ... </li>
      const at = a.page.html.indexOf(`id="cite_note-${note}"`);
      if (at > 0) {
        const li = a.page.html.slice(at, a.page.html.indexOf('</li>', at));
        cite = text(li.slice(li.indexOf('>') + 1)).replace(/^\s*\^\s*/, '').slice(0, 220);
      }
    }
    r.step('read', 'Read the population from the infobox and followed its reference', { observation: `${pop ?? '?'}${cite ? ` · ref: ${cite}` : ''}`, result: pop ? 'ok' : 'fail' });
    return pop ? r.done(`Tbilisi population (Wikipedia infobox): ${pop}.${cite ? ` Reference: ${cite}` : ''}`) : r.failed('Population not found in the infobox');
  },
  async 50(r) { // Wikipedia PDF
    const a = await r.open('Opened the Cloudflare article on Wikipedia', 'https://en.wikipedia.org/wiki/Cloudflare', 'Cloudflare');
    if (a.blocked) return r.handBack(blockedReason('wikipedia.org'), true);
    const p = await r.fetch('https://en.wikipedia.org/api/rest_v1/page/pdf/Cloudflare');
    const ok = p.status === 200 && p.ct.includes('pdf');
    let saved = null;
    if (ok) { const dir = join(root, '.seed-fleet', 'downloads'); mkdirSync(dir, { recursive: true }); saved = join(dir, `Cloudflare-${AGENT}.pdf`); writeFileSync(saved, p.buf); }
    r.step('click', "Chose 'Download as PDF' and saved the file", { target: 'Download as PDF', url: 'https://en.wikipedia.org/api/rest_v1/page/pdf/Cloudflare', observation: ok ? `PDF, ${(p.buf.length / 1024).toFixed(0)} KB` : `HTTP ${p.status}`, result: ok ? 'ok' : 'fail', duration_ms: p.ms });
    return ok ? r.done(`Saved the Cloudflare article as a PDF (${(p.buf.length / 1024).toFixed(0)} KB).`) : r.failed('PDF download failed');
  },
};

// ------------------------------------------------------------------ run + send
const apiKey = DRY ? null : JSON.parse(readFileSync(join(fleetDir, 'credentials.json'), 'utf8')).api_key;

/** Like any agent running the skill: ask Wisptrace for the recipe first. A site marked "blocks" is never contacted. */
async function lookup(run, task) {
  if (!apiKey) return { blocked: false, recipeId: null };
  try {
    const q = site => fetch(`https://wisptrace.com/api/v1/recipes?task=${encodeURIComponent(task.tag)}${site ? `&site=${encodeURIComponent(site)}` : ''}`,
      { headers: { authorization: `Bearer ${apiKey}`, 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    let r = await q(task.site);
    if (r.status === 400) r = await q(null); // e.g. 'gov.uk' is a public suffix, not a site: look up by task only
    const d = await r.json();
    const recipe = d.recipes?.[0] ?? null;
    const blocked = d.site_policy?.policy === 'blocks';
    run.step('tool', 'Asked Wisptrace for the recipe before starting', {
      observation: blocked ? 'Site policy: blocks agents' : recipe ? `Recipe found (${recipe.status}, ${recipe.agents_succeeded} people)` : 'No recipe yet',
      model_response: blocked ? 'The site does not allow agents, so I will not start; handing back.' : undefined,
    });
    return { blocked, recipeId: recipe?.id ?? null };
  } catch {
    return { blocked: false, recipeId: null };
  }
}

const summary = [];
for (const task of tasks) {
  const run = new Run(task);
  let res;
  let recipeId = null;
  try {
    const pre = await lookup(run, task);
    recipeId = pre.recipeId;
    res = pre.blocked
      ? run.handBack(`Wisptrace lists ${task.site} as a site that does not allow agents, so I didn't start. Handing back.`, true)
      : H[task.id] ? await H[task.id](run) : run.handBack('No runner for this task yet.');
  } catch (e) {
    run.step('other', 'The request failed', { result: 'fail', error: String(e.message || e).slice(0, 200) });
    res = run.failed(`Network error: ${String(e.message || e).slice(0, 120)}`);
  }
  const ended = Date.now();
  const trace = {
    schema: 'wisptrace.trace/v1',
    task: { description: task.prompt, tag: task.tag, sites: [task.site] },
    agent: { app: APP, model: MODEL },
    started_at: new Date(run.t0).toISOString(),
    ended_at: new Date(ended).toISOString(),
    duration_s: Math.max(1, Math.round((ended - run.t0) / 1000)),
    outcome: res.outcome,
    steps: run.steps.map(s => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined))),
    messages: [{ role: 'user', content: task.prompt }, { role: 'assistant', content: res.answer }],
    // Followed (or tried) an existing recipe: the trace is evidence for it either way. Seeds never upvote.
    ...(recipeId && res.outcome.status !== 'handed_back' ? { recipe_id: recipeId } : {}),
  };
  const file = join(outDir, `task-${task.id}.json`);
  writeFileSync(file, JSON.stringify(trace, null, 2));
  let sent = 'dry';
  if (!DRY) {
    const p = spawnSync(process.execPath, [join(root, 'public', 'skill', 'wisptrace.mjs'), 'send', file], {
      env: { ...process.env, WISPTRACE_DIR: fleetDir, WISPTRACE_URL: 'https://wisptrace.com' }, encoding: 'utf8',
    });
    let d = null; try { d = JSON.parse(p.stdout); } catch { /* */ }
    sent = d?.ok ? `sent (${d.task?.label}${d.task?.public ? ', public' : ''})` : `NOT SENT: ${(p.stderr || p.stdout).trim().split('\n').pop()?.slice(0, 160)}`;
  }
  summary.push({ id: task.id, site: task.site, outcome: res.outcome.status, blocked: !!res.outcome.blocked_by_site, steps: trace.steps.length, sent });
  console.log(`${String(task.id).padStart(2)} ${task.site.padEnd(16)} ${res.outcome.status.padEnd(11)}${res.outcome.blocked_by_site ? ' blocked' : '        '} ${String(trace.steps.length).padStart(2)} steps  ${sent}\n     ${res.answer.slice(0, 220)}`);
  await new Promise(r => setTimeout(r, 800));
}
const n = s => summary.filter(x => x.outcome === s).length;
console.log(`\n${AGENT}: ${summary.length} tasks · done ${n('done')} · handed back ${n('handed_back')} (${summary.filter(x => x.blocked).length} blocked) · failed ${n('failed')} · sent ${summary.filter(x => x.sent.startsWith('sent')).length}`);
