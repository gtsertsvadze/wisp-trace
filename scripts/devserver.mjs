#!/usr/bin/env node
// Isolated local dev servers, so several people (or agents) can run wrangler dev side by side.
//
//   node scripts/devserver.mjs start --port 8711 [--state .wrangler/state-8711] [--fixture] [--fresh]
//   node scripts/devserver.mjs stop  --port 8711
//   node scripts/devserver.mjs sql   --port 8711 "SELECT count(*) FROM traces"
//
// start: applies migrations to the state dir, launches wrangler dev in the background (log:
// .wrangler/logs/dev-<port>.log), waits until it answers, and with --fixture fills it with demo data through
// the real API (scripts/fixture.mjs, local only). --fresh wipes the state dir first.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerBin = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const [cmd, ...rest] = process.argv.slice(2);
const arg = (name, def) => {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = rest[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const port = Number(arg('port', 8787));
const state = resolve(root, arg('state', `.wrangler/state-${port}`));
const pidFile = join(root, '.wrangler', 'pids', `${port}.pid`);
const logFile = join(root, '.wrangler', 'logs', `dev-${port}.log`);

function wrangler(args, opts = {}) {
  const r = spawnSync(process.execPath, [wranglerBin, ...args], { cwd: root, encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    process.stderr.write(r.stdout + r.stderr);
    throw new Error(`wrangler ${args.join(' ')} failed`);
  }
  return r.stdout;
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
}

async function waitReady(ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 700));
    }
  }
  return false;
}

async function start() {
  stop(true);
  if (arg('fresh', false)) rmSync(state, { recursive: true, force: true });
  mkdirSync(dirname(pidFile), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });
  wrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
  const log = openSync(logFile, 'w');
  const child = spawn(
    process.execPath,
    [wranglerBin, 'dev', '--port', String(port), '--inspector-port', String(port + 1000), '--persist-to', state, '--ip', '127.0.0.1'],
    { cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true },
  );
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  const ok = await waitReady();
  console.log(ok ? `ready http://127.0.0.1:${port}  (state ${state}, log ${logFile})` : `NOT READY after 60s, see ${logFile}`);
  if (ok && arg('fixture', false)) {
    const fx = join(root, 'scripts', 'fixture.mjs');
    const creds = join(root, '.wrangler', `fixture-${port}-creds.sql`);
    const r = spawnSync(process.execPath, [fx, '--url', `http://127.0.0.1:${port}`, '--creds-sql', creds], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('fixture.mjs failed');
    wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--file', creds, '--yes']);
    console.log('fixture loaded: owner page /owner/wto_devQuietfox7OwnerToken0000000000, claim page /claim/ne7-test');
  }
  process.exit(ok ? 0 : 1);
}

function stop(quiet = false) {
  if (existsSync(pidFile)) {
    killTree(Number(readFileSync(pidFile, 'utf8')));
    rmSync(pidFile, { force: true });
    if (!quiet) console.log(`stopped dev server on ${port}`);
  } else if (!quiet) console.log(`no dev server recorded on ${port}`);
}

function sql() {
  const q = rest.filter((x, i) => !x.startsWith('--') && !(rest[i - 1] || '').startsWith('--')).join(' ');
  process.stdout.write(wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--command', q, '--json']));
}

if (cmd === 'start') await start();
else if (cmd === 'stop') stop();
else if (cmd === 'sql') sql();
else {
  console.log('usage: node scripts/devserver.mjs start|stop|sql --port N [--state DIR] [--fixture] [--fresh]');
  process.exit(1);
}
