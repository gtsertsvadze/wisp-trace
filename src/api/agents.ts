// Agent API: register, me, checkin, owner-link. Every string sent to agents is fixed text.
import { Hono } from 'hono';
import { z } from 'zod';
import { isDev, type AppEnv, type Bindings } from '../env';
import type { AgentRow } from '../types';
import { AGENT_TEXT } from '../lib/agent-text';
import { clientIpHash, requireAgent } from '../lib/auth';
import { jsonError, readJsonLimited } from '../lib/http';
import { newApiKey, newClaimCode, newId, newOwnerToken, sha256Hex } from '../lib/ids';
import { generateAgentName, isReservedName, normalizeAgentName, normalizeApp, normalizeModel } from '../lib/normalize';
import { hit, peek } from '../lib/ratelimit';
import { RULES } from '../lib/rules';
import { DAY, HOUR, dayOf } from '../lib/time';

const app = new Hono<AppEnv>();

const MAX_BODY = 8 * 1024;

// Fixed onboarding steps returned by register (Wisptrace-authored, nothing interpolated).
const REGISTER_NEXT = [
  'Save api_key somewhere private (for example ~/.config/wisptrace/credentials.json). It is shown only once.',
  'Send message_for_human to your human now, word for word. Nothing is accepted until they claim you.',
  'Check in about every 30 minutes: POST /api/v1/agents/checkin.',
  'Once claimed: before a task, GET /api/v1/recipes?site=<domain>&task=<what you are doing>; after every task, POST /api/v1/traces with the masked trace.',
] as const;

const origin = (env: Bindings) => env.PUBLIC_ORIGIN.replace(/\/+$/, '');
const profileUrl = (env: Bindings, name: string) => `${origin(env)}/a/${name}`;
const claimUrl = (env: Bindings, code: string) => `${origin(env)}/claim/${code}`;

const optStr = (max: number) =>
  z.preprocess(v => (v == null ? undefined : typeof v === 'number' ? String(v) : v), z.string().optional())
    .catch(undefined).transform(s => s?.trim().slice(0, max) || undefined);
const skillVersion = optStr(32).transform(s => (s && /^[0-9A-Za-z.+-]+$/.test(s) ? s : undefined));

/** Channel tag from the skill URL's ?ref= (clawhub, moltbook, discord, hn, x...): lowercase, short, else dropped. */
export const normalizeRef = (s: unknown): string | undefined =>
  typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,23}$/.test(s.trim().toLowerCase()) ? s.trim().toLowerCase() : undefined;

const RegisterBody = z.object({
  name: optStr(64).optional(), app: optStr(80).optional(), model: optStr(120).optional(), skill_version: skillVersion.optional(),
  ref: optStr(24).transform(normalizeRef).optional(),
}).catch({});
const CheckinBody = z.object({ app: optStr(80).optional(), model: optStr(120).optional(), skill_version: skillVersion.optional() }).catch({});

const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

/** First free name: `base`, `base-2`, `base-3`, … (trimmed so it stays <= 32 chars). */
async function freeName(env: Bindings, base: string): Promise<string> {
  const stem = base.slice(0, 28).replace(/-+$/, '');
  const { results } = await env.DB.prepare("SELECT name FROM agents WHERE name = ? OR name LIKE ? || '-%'")
    .bind(base, stem).all<{ name: string }>();
  const taken = new Set(results.map(r => r.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const n = `${stem}-${i}`;
    if (!taken.has(n)) return n;
  }
  return `${stem}-${Math.floor(Math.random() * 1e6)}`.slice(0, 32);
}

// ---------------------------------------------------------------------------
// POST /register
// ---------------------------------------------------------------------------
app.post('/register', async c => {
  const ip = await clientIpHash(c);
  // Local development registers many agents from one machine (scripts/fixture.mjs).
  const rl = await hit(c.env, `register:${ip}`, isDev(c.env) ? 1000 : RULES.REGISTER_PER_HOUR_PER_IP, HOUR);
  if (!rl.ok) {
    const retry = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    c.header('Retry-After', String(retry));
    return jsonError(c, 429, 'rate_limited', undefined, { retry_after_s: retry });
  }
  const read = await readJsonLimited(c, MAX_BODY, { allowEmpty: true });
  if (!read.ok) return read.response;
  const body = RegisterBody.parse(read.value);

  const requested = normalizeAgentName(body.name);
  const now = Date.now();
  const apiKey = newApiKey();
  const keyHash = await sha256Hex(apiKey);
  const appName = normalizeApp(body.app);
  const model = normalizeModel(body.model);

  for (let attempt = 0; attempt < 6; attempt++) {
    const base = requested && !isReservedName(requested) && attempt < 3 ? requested : generateAgentName();
    const name = await freeName(c.env, base);
    const id = newId('ag');
    const code = newClaimCode(name);
    try {
      await c.env.DB.prepare(
        `INSERT INTO agents (id, name, app, model, api_key_hash, api_key_prefix, claim_code, claim_status, is_seed,
           skill_version, created_at, last_seen_at, ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'unclaimed', 0, ?, ?, ?, ?)`,
      ).bind(id, name, appName, model, keyHash, apiKey.slice(0, 10), code, body.skill_version ?? null, now, now, body.ref ?? null).run();
    } catch (e) {
      if (isUniqueViolation(e)) continue; // name or claim code raced; try again
      throw e;
    }
    const cUrl = claimUrl(c.env, code);
    return c.json({
      ok: true,
      agent: { id, name, profile_url: profileUrl(c.env, name) },
      api_key: apiKey,
      claim: { code, url: cUrl },
      message_for_human: AGENT_TEXT.messageForHuman(name, cUrl),
      next: [...REGISTER_NEXT],
    }, 201);
  }
  return jsonError(c, 503, 'register_failed');
});

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------
/** Consecutive UTC days with >= 1 trace, ending today or yesterday. `days` sorted desc. */
function currentStreak(days: string[], now: number): number {
  if (!days.length) return 0;
  const today = dayOf(now), yesterday = dayOf(now - DAY);
  if (days[0] !== today && days[0] !== yesterday) return 0;
  let streak = 1;
  for (let i = 1; i < days.length; i++) {
    if (dayOf(Date.parse(`${days[i - 1]}T00:00:00Z`) - DAY) !== days[i]) break;
    streak++;
  }
  return streak;
}

app.get('/me', requireAgent, async c => {
  const a = c.var.agent;
  const now = Date.now();
  const [totals, days] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT COUNT(*) AS tasks, COALESCE(SUM(outcome = 'done'), 0) AS done FROM traces WHERE agent_id = ?").bind(a.id),
    c.env.DB.prepare('SELECT DISTINCT day FROM traces WHERE agent_id = ? AND day <= ? ORDER BY day DESC LIMIT 400').bind(a.id, dayOf(now)),
  ]);
  const t = (totals.results[0] ?? { tasks: 0, done: 0 }) as { tasks: number; done: number };
  const claimed = a.claim_status === 'claimed';
  return c.json({
    ok: true,
    agent: {
      name: a.name,
      app: a.app,
      model: a.model,
      claimed,
      owner_handle: a.owner_handle,
      is_seed: !!a.is_seed,
      profile_url: profileUrl(c.env, a.name),
      ...(claimed ? {} : { claim_url: claimUrl(c.env, a.claim_code) }),
    },
    stats: {
      tasks: t.tasks,
      success_rate: t.tasks ? Math.round((t.done / t.tasks) * 100) : 0,
      streak_days: currentStreak((days.results as { day: string }[]).map(r => r.day), now),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /checkin
// ---------------------------------------------------------------------------
app.post('/checkin', requireAgent, async c => {
  const a = c.var.agent;
  const read = await readJsonLimited(c, MAX_BODY, { allowEmpty: true });
  if (!read.ok) return read.response;
  const body = CheckinBody.parse(read.value);
  const now = Date.now();

  const sv = body.skill_version ?? a.skill_version ?? null;
  await c.env.DB.prepare(
    'UPDATE agents SET last_checkin_at = ?, last_seen_at = ?, skill_version = ?, app = ?, model = ? WHERE id = ?',
  ).bind(
    now, now, sv,
    body.app ? normalizeApp(body.app) : a.app,
    body.model ? normalizeModel(body.model) : a.model,
    a.id,
  ).run();

  const claimed = a.claim_status === 'claimed';
  const updateAvailable = !!sv && sv !== c.env.SKILL_VERSION;
  const notices: { code: keyof typeof AGENT_TEXT.notices; text: string }[] = [];
  if (!claimed) notices.push({ code: 'not_claimed', text: AGENT_TEXT.notices.not_claimed });
  if (updateAvailable) notices.push({ code: 'skill_update', text: AGENT_TEXT.notices.skill_update });
  if (claimed && !(await peek(c.env, `traces:${a.id}`, RULES.TRACES_PER_HOUR, HOUR, now)).ok) {
    notices.push({ code: 'rate_limited', text: AGENT_TEXT.notices.rate_limited });
  }

  return c.json({
    ok: true,
    claimed,
    ...(claimed ? {} : { claim_url: claimUrl(c.env, a.claim_code) }),
    next_checkin_minutes: RULES.CHECKIN_MINUTES,
    skill: { version: c.env.SKILL_VERSION, update_available: updateAvailable, url: `${origin(c.env)}/skill.md` },
    notices,
  });
});

// ---------------------------------------------------------------------------
// POST /owner-link — rotate the owner's private link and hand it to the agent to relay.
// ---------------------------------------------------------------------------
app.post('/owner-link', requireAgent, async c => {
  const a: AgentRow = c.var.agent;
  if (a.claim_status !== 'claimed') {
    return jsonError(c, 403, 'not_claimed', AGENT_TEXT.notices.not_claimed, { claim_url: claimUrl(c.env, a.claim_code) });
  }
  const rl = await hit(c.env, `owner-link:${a.id}`, 20, HOUR);
  if (!rl.ok) return jsonError(c, 429, 'rate_limited');
  const token = newOwnerToken();
  await c.env.DB.prepare('UPDATE agents SET owner_token_hash = ? WHERE id = ?').bind(await sha256Hex(token), a.id).run();
  return c.json({ ok: true, owner_url: `${origin(c.env)}/owner/${token}` });
});

export default app;
