#!/usr/bin/env node
// Screenshot a page with the locally installed Chrome/Edge (playwright-core, no browser download).
//   node scripts/shot.mjs <url-or-file> <out.png> [--width 1440] [--height 900] [--full] [--wait 1500]
// Design references: node scripts/shot.mjs docs/design/Feed.dc.html screenshots/design-feed.png --full
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, resolve } from 'node:path';

const [target, out, ...rest] = process.argv.slice(2);
if (!target || !out) {
  console.log('usage: node scripts/shot.mjs <url-or-file> <out.png> [--width 1440] [--height 900] [--full] [--wait 1500]');
  process.exit(1);
}
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i === -1 ? d : rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true; };
const width = Number(opt('width', 1440));
const height = Number(opt('height', 900));
const wait = Number(opt('wait', 1500));
// Local files are served over http (the design runtime fetches its own source, which file:// blocks).
let server = null;
let url = target;
if (!/^https?:/.test(target)) {
  const dir = dirname(resolve(target));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  server = createServer((req, res) => {
    const p = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(dir) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(readFileSync(p));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/${encodeURIComponent(basename(target))}`;
}

const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const executablePath = candidates.find(p => existsSync(p));
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 }).catch(e => errors.push(String(e)));
await page.waitForTimeout(wait);
mkdirSync(dirname(resolve(out)), { recursive: true });
await page.screenshot({ path: out, fullPage: !!opt('full', false) });
await browser.close();
server?.close();
console.log(`saved ${out}${errors.length ? `\nconsole errors:\n  ${errors.join('\n  ')}` : ''}`);
