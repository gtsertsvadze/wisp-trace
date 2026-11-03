// Admin API (Authorization: Bearer <ADMIN_TOKEN>). Seed agents, site policies, job runs, and
// development-only helpers used by scripts/simulate.mjs (claim without a post, backfill history).
import { Hono } from 'hono';
import { z } from 'zod';
import { isDev, type AppEnv, type Bindings } from '../env';
import type { AgentRow, SitePolicy } from '../types';
import { requireAdmin } from '../lib/auth';
import { jsonError, readJsonLimited } from '../lib/http';
import { newApiKey, newClaimCode, newId, newOwnerToken, sha256Hex } from '../lib/ids';
import { AGENT_NAME_RE, normalizeAgentName, normalizeApp, normalizeModel, registrableDomain } from '../lib/normalize';
import { RULES } from '../lib/rules';
import { runJobs, type JobName } from '../processing/cron';
import { IngestError, MaskingUnavailableError, ingestTrace } from '../processing/ingest';
import { setSitePolicy } from '../processing/policies';

const app = new Hono<AppEnv>();
app.use('*', requireAdmin);

const SMALL_BODY = 16 * 1024;
const JOBS: readonly JobName[] = ['recipes', 'trends', 'awards', 'snapshots'];
const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

const origin = (env: Bindings) => env.PUBLIC_ORIGIN.replace(/\/+$/, '');
const optStr = (max: number) => z.string().trim().max(max).optional().nullable().transform(s => s || undefined);
const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

async function readBody<T>(c: Parameters<typeof readJsonLimited>[0], schema: z.ZodType<T>, maxBytes = SMALL_BODY) {
  const read = await readJsonLimited(c, maxBytes);
  if (!read.ok) return { ok: false as const, response: read.response };
  const parsed = schema.safeParse(read.value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map(i => `${i.path.join('.') || 'body'}: ${i.message}`);
    return { ok: false as const, response: jsonError(c, 400, 'invalid_body', undefined, { issues }) };
  }
  return { ok: true as const, value: parsed.data };
}

async function agentByName(env: Bindings, name: string): Promise<AgentRow | null> {
  return env.DB.prepare('SELECT * FROM agents WHERE name = ?').bind(name).first<AgentRow>();
}

// ---------------------------------------------------------------------------
// POST /seed-agents — Wisptrace's own, clearly labelled agents. The only place a 'seed-' name can be created.
// ---------------------------------------------------------------------------
const SeedBody = z.object({ name: optStr(64), app: optStr(80), model: optStr(120) });

app.post('/seed-agents', async c => {
  const body = await readBody(c, SeedBody);
  if (!body.ok) return body.response;
  const name = normalizeAgentName(body.value.name);
  if (body.value.name && !name) return jsonError(c, 400, 'invalid_name', 'Name must match ^[a-z0-9][a-z0-9-]{2,31}$.');
  if (name && !AGENT_NAME_RE.test(name)) return jsonError(c, 400, 'invalid_name');

  const now = Date.now();
  const apiKey = newApiKey();
  const ownerToken = newOwnerToken();
  const [keyHash, ownerHash] = await Promise.all([sha256Hex(apiKey), sha256Hex(ownerToken)]);
  const appName = normalizeApp(body.value.app);
  const model = normalizeModel(body.value.model);

  for (let attempt = 0; attempt < 5; attempt++) {
    const finalName = name ?? `seed-${String(Math.floor(Math.random() * 90) + 10)}`;
    const id = newId('ag');
    try {
      await c.env.DB.prepare(
        `INSERT INTO agents (id, name, app, model, api_key_hash, api_key_prefix, claim_code, claim_status, claimed_at,
           owner_handle, owner_platform, owner_token_hash, is_seed, skill_version, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', ?, 'Wisptrace', 'seed', ?, 1, ?, ?, ?)`,
      ).bind(id, finalName, appName, model, keyHash, apiKey.slice(0, 10), newClaimCode(finalName), now, ownerHash, c.env.SKILL_VERSION ?? null, now, now).run();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (name) {
        const existing = await agentByName(c.env, name);
        if (existing) return jsonError(c, 409, 'name_taken', `An agent named "${name}" already exists.`);
      }
      continue; // generated name or claim code raced; try again
    }
    return c.json({
      ok: true,
      api_key: apiKey,
      agent: { id, name: finalName, app: appName, model, is_seed: true, claimed: true, profile_url: `${origin(c.env)}/a/${finalName}` },
      owner_url: `${origin(c.env)}/owner/${ownerToken}`,
    }, 201);
  }
  return jsonError(c, 503, 'seed_failed');
});

// ---------------------------------------------------------------------------
// POST /site-policy — manual policy for a site ('blocks' sites get no recipes; agents are told to hand back).
// ---------------------------------------------------------------------------
const PolicyBody = z.object({
  site: z.string().trim().min(1).max(500),
  policy: z.enum(['allows', 'blocks', 'unknown']),
  note: optStr(300),
});

app.post('/site-policy', async c => {
  const body = await readBody(c, PolicyBody);
  if (!body.ok) return body.response;
  const site = registrableDomain(body.value.site);
  if (!site) return jsonError(c, 400, 'invalid_site', 'site must be a public domain or URL.');
  const policy: SitePolicy = body.value.policy;
  await setSitePolicy(c.env, site, policy, body.value.note ?? null, 'manual');
  return c.json({ ok: true, site, policy, note: body.value.note ?? null });
});

// ---------------------------------------------------------------------------
// POST /run-jobs — run cron jobs now. { jobs?: JobName[], week?: '2026-W44' }
// ---------------------------------------------------------------------------
const JobsBody = z.object({
  jobs: z.array(z.enum(['recipes', 'trends', 'awards', 'snapshots'])).min(1).optional(),
  week: z.string().regex(WEEK_RE, 'expected an ISO week like 2026-W44').optional(),
}).catch({});

app.post('/run-jobs', async c => {
  const read = await readJsonLimited(c, SMALL_BODY, { allowEmpty: true });
  if (!read.ok) return read.response;
  const body = JobsBody.parse(read.value);
  const jobs = body.jobs ? [...new Set(body.jobs)] : [...JOBS];
  const t0 = Date.now();
  const result = await runJobs(c.env, jobs, { week: body.week });
  return c.json({ ok: true, jobs: result, ms: Date.now() - t0 });
});

// ---------------------------------------------------------------------------
// GET /summary — counts for operators and the simulator's end-of-run report (derived data only).
// ---------------------------------------------------------------------------
app.get('/summary', async c => {
  const db = c.env.DB;
  const [agents, traces, recipes, policies, awards, tasks, masks, refs] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(claim_status = 'claimed'), 0) AS claimed, COALESCE(SUM(is_seed), 0) AS seed,
                COALESCE(SUM(deleted_at IS NOT NULL), 0) AS deleted FROM agents`),
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(outcome = 'done'), 0) AS done, COALESCE(SUM(outcome = 'failed'), 0) AS failed,
                COALESCE(SUM(outcome = 'handed_back'), 0) AS handed_back, MIN(day) AS first_day, MAX(day) AS last_day FROM traces`),
    db.prepare('SELECT status, COUNT(*) AS n FROM recipes GROUP BY status ORDER BY status'),
    db.prepare('SELECT site, policy, source, reports FROM site_policies ORDER BY site'),
    db.prepare('SELECT week, award, subject_type, subject, value FROM awards ORDER BY week DESC, award'),
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(crowd >= ${RULES.TASK_PUBLIC_MIN_CROWD}), 0) AS public, COALESCE(SUM(sensitive), 0) AS sensitive FROM tasks`),
    db.prepare('SELECT COALESCE(SUM(mask_client), 0) AS client, COALESCE(SUM(mask_server), 0) AS server FROM traces'),
    db.prepare(`SELECT COALESCE(ref, '(none)') AS ref, COUNT(*) AS agents, COALESCE(SUM(claim_status = 'claimed'), 0) AS claimed
                FROM agents WHERE is_seed = 0 GROUP BY COALESCE(ref, '(none)') ORDER BY agents DESC`),
  ]);
  return c.json({
    ok: true,
    agents: agents.results[0],
    traces: traces.results[0],
    recipes: Object.fromEntries((recipes.results as { status: string; n: number }[]).map(r => [r.status, r.n])),
    site_policies: policies.results,
    awards: awards.results,
    tasks: tasks.results[0],
    mask_counts: masks.results[0],
    channels: refs.results, // registrations and claims per ?ref= channel
  });
});

// ---------------------------------------------------------------------------
// Development only. 404 in production so these never exist there.
// ---------------------------------------------------------------------------
app.use('/dev/*', async (c, next) => {
  if (!isDev(c.env)) return jsonError(c, 404, 'not_found');
  await next();
});

const DevClaimBody = z.object({ name: z.string().trim().min(3).max(64), handle: optStr(64) });

app.post('/dev/claim', async c => {
  const body = await readBody(c, DevClaimBody);
  if (!body.ok) return body.response;
  const name = normalizeAgentName(body.value.name);
  const agent = name ? await agentByName(c.env, name) : null;
  if (!agent || agent.deleted_at) return jsonError(c, 404, 'agent_not_found');
  const handle = body.value.handle ? `@${body.value.handle.replace(/^@+/, '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || `dev-${agent.name}`}` : `@dev-${agent.name}`;
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE agents SET claim_status = 'claimed', claimed_at = COALESCE(claimed_at, ?), owner_handle = ?, owner_platform = 'dev',
       owner_post_url = ? WHERE id = ?`,
  ).bind(now, handle, `dev://${handle.slice(1)}`, agent.id).run();
  return c.json({
    ok: true,
    agent: { id: agent.id, name: agent.name, claimed: true, owner_handle: handle, owner_platform: 'dev', profile_url: `${origin(c.env)}/a/${agent.name}` },
  });
});

const BackfillBody = z.object({
  agent_name: z.string().trim().min(3).max(64),
  occurred_at: z.union([z.string().min(4).max(64), z.number().finite()]),
  trace: z.unknown(),
});

/** ISO string or epoch ms/s -> epoch ms, or null. */
function parseOccurredAt(v: string | number): number | null {
  if (typeof v === 'number') return v > 1e12 ? Math.round(v) : v > 1e9 ? Math.round(v * 1000) : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

app.post('/dev/backfill', async c => {
  const body = await readBody(c, BackfillBody, RULES.TRACE_MAX_BYTES + SMALL_BODY);
  if (!body.ok) return body.response;
  const name = normalizeAgentName(body.value.agent_name);
  const agent = name ? await agentByName(c.env, name) : null;
  if (!agent) return jsonError(c, 404, 'agent_not_found');
  const occurredAt = parseOccurredAt(body.value.occurred_at);
  if (occurredAt == null || occurredAt > Date.now() + 60_000) return jsonError(c, 400, 'invalid_occurred_at', 'occurred_at must be a past ISO time or epoch ms.');
  try {
    const result = await ingestTrace(c.env, agent, body.value.trace, { occurredAt });
    return c.json({ ...result, occurred_at: occurredAt }, 201);
  } catch (err) {
    if (err instanceof IngestError) {
      const { message, ...extra } = err.extra as { message?: string } & Record<string, unknown>;
      return jsonError(c, err.status, err.code, message, extra);
    }
    if (err instanceof MaskingUnavailableError) return jsonError(c, 503, 'masking_unavailable');
    throw err;
  }
});

export default app;
