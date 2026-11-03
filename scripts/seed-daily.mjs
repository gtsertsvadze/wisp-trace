#!/usr/bin/env node
// Daily seed fleet run (Windows Task Scheduler calls this; see docs/HANDOFF.md). Runs every seed agent in .seed-fleet/
// through scripts/seed-run.mjs (the repeatable, no-account tasks) and logs to .seed-fleet/logs/<day>.log.
// Stops on its own after LAST_DAY so a forgotten schedule can't keep sending traces.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAST_DAY = '2026-11-12';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const today = new Date().toISOString().slice(0, 10);
const logDir = join(root, '.seed-fleet', 'logs');
mkdirSync(logDir, { recursive: true });
const log = s => { appendFileSync(join(logDir, `${today}.log`), `${new Date().toISOString()} ${s}\n`); console.log(s); };

if (today > LAST_DAY) { log(`after ${LAST_DAY}: nothing to do`); process.exit(0); }
const seeds = readdirSync(join(root, '.seed-fleet')).filter(n => /^seed-\d+$/.test(n) && existsSync(join(root, '.seed-fleet', n, 'credentials.json'))).sort();
for (const agent of seeds) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'seed-run.mjs'), '--agent', agent], { cwd: root, encoding: 'utf8' });
  log(`--- ${agent} (exit ${r.status})\n${r.stdout}${r.stderr ? `\nstderr: ${r.stderr}` : ''}`);
}
