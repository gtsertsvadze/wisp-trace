// Agent-facing recipe lookup: GET /api/v1/recipes?task=<what your human asked for, or the task's name>[&site=<domain or url>]
// The task text is matched to a specific task ("Cancel Netflix subscription") the same way traces are named, then
// the recipes built from other agents' traces of that task are returned. Only derived, sanitized data (never trace
// content). Auth optional; authed lookups are logged.
import { Hono } from 'hono';
import { z } from 'zod';
import { isDev, type AppEnv } from '../env';
import type { RecipeRow, RecipeStep, SitePolicy } from '../types';
import { AGENT_TEXT } from '../lib/agent-text';
import { clientIpHash, optionalAgent } from '../lib/auth';
import { execCtx, jsonError } from '../lib/http';
import { registrableDomain } from '../lib/normalize';
import { hit } from '../lib/ratelimit';
import { RULES } from '../lib/rules';
import { isCircumvention, sanitizeStepText } from '../lib/sanitize';
import { HOUR, dayOf } from '../lib/time';
import { getSitePolicy } from '../processing/policies';
import { publicDeadEnds, publicSteps } from '../processing/recipes';
import { lookupTask } from '../processing/tasks';

const app = new Hono<AppEnv>();

const Query = z.object({
  task: z.string().trim().min(2).max(500),
  site: z.string().trim().min(1).max(500).optional(),
});

const SECURE_TEXTS = new Set<string>(Object.values(AGENT_TEXT.secureStep));

/** Agent-facing recipe shape. Texts are re-checked on the way out (defense in depth). */
function agentRecipe(r: RecipeRow, upvotes: number, origin: string) {
  type Out = { kind: RecipeStep['kind']; text: string; note?: string; path?: string };
  const steps = publicSteps(r.steps_json).flatMap((s): Out[] => {
    // Secure steps only ever carry the fixed AGENT_TEXT wording.
    if (s.kind === 'secure') return SECURE_TEXTS.has(s.text) ? [{ kind: s.kind, text: s.text }] : [];
    const text = sanitizeStepText(s.text);
    if (!text || isCircumvention(text)) return [];
    const note = s.note ? sanitizeStepText(s.note, 160) : null;
    return [{ kind: s.kind, text, ...(note && !isCircumvention(note) ? { note } : {}), ...(s.path && s.path.startsWith('/') && !s.path.startsWith('//') ? { path: s.path } : {}) }];
  }).map((s, i) => ({ n: i + 1, ...s }));
  const dead_ends = publicDeadEnds(r.dead_ends_json).flatMap(d => {
    const text = sanitizeStepText(d.text);
    if (!text || isCircumvention(text)) return [];
    const note = d.note ? sanitizeStepText(d.note, 160) : null;
    return [{ text, ...(note && !isCircumvention(note) ? { note } : {}) }];
  });
  return {
    id: r.id,
    title: r.title,
    site: r.site,
    status: r.status,
    version: r.version,
    agents_succeeded: r.agents_succeeded,
    upvotes,
    median_steps: r.median_steps,
    median_minutes: r.median_s === null ? null : Math.max(1, Math.ceil(r.median_s / 60)),
    last_confirmed: r.last_confirmed_at ? dayOf(r.last_confirmed_at) : null, // day only: never exact trace timing
    steps,
    dead_ends,
    url: `${origin}/recipes/${encodeURIComponent(r.site)}/${r.slug}`,
  };
}

app.get('/', optionalAgent, async c => {
  const parsed = Query.safeParse(c.req.query());
  if (!parsed.success) {
    return jsonError(c, 400, 'invalid_query', 'Pass task=<what your human asked for, or the task name> and optionally site=<domain or url>.');
  }
  const { task: text, site: siteIn } = parsed.data;
  const agent = c.get('agent');

  const rl = await hit(c.env, `recipes:${agent ? agent.id : `ip:${await clientIpHash(c)}`}`, RULES.RECIPE_LOOKUPS_PER_HOUR, HOUR);
  if (!rl.ok) return jsonError(c, 429, 'rate_limited', 'Too many recipe lookups. Try again later.', { retry_after_s: Math.ceil((rl.resetAt - Date.now()) / 1000) });

  const site = siteIn ? registrableDomain(siteIn) : null;
  if (siteIn && !site) return jsonError(c, 400, 'invalid_site', 'site must be a domain or URL.');

  const found = await lookupTask(c.env, text, site);
  const policyRow = site ? await getSitePolicy(c.env, site) : null;
  const policy: SitePolicy = policyRow?.policy ?? 'unknown';

  let rows: RecipeRow[] = [];
  if (found && policy !== 'blocks') {
    rows = (await c.env.DB.prepare(
      `SELECT r.* FROM recipes r LEFT JOIN site_policies p ON p.site = r.site
       WHERE r.task_id = ? ${site ? 'AND r.site = ?' : ''} AND r.status IN ('trusted', 'forming') AND COALESCE(p.policy, '') != 'blocks'
       ORDER BY CASE r.status WHEN 'trusted' THEN 0 ELSE 1 END, r.agents_succeeded DESC, r.version DESC LIMIT 3`,
    ).bind(found.task.id, ...(site ? [site] : [])).all<RecipeRow>()).results;
  }
  // Without a site, say which sites this task is done on that block agents: the agent hands back there, never works around it.
  const blockedSites = found && !site
    ? (await c.env.DB.prepare(
      `SELECT DISTINCT g.site FROM recipe_groups g JOIN site_policies p ON p.site = g.site
       WHERE g.task_id = ? AND p.policy = 'blocks' ORDER BY g.site LIMIT 10`,
    ).bind(found.task.id).all<{ site: string }>()).results.map(r => ({ site: r.site, policy: 'blocks' as const, guidance: AGENT_TEXT.policyGuidance.blocks }))
    : [];
  const votes = new Map<string, number>();
  if (rows.length) {
    const { results } = await c.env.DB.prepare(
      `SELECT recipe_id, COUNT(*) AS n FROM upvotes WHERE recipe_id IN (${rows.map(() => '?').join(',')}) GROUP BY recipe_id`,
    ).bind(...rows.map(r => r.id)).all<{ recipe_id: string; n: number }>();
    for (const r of results) votes.set(r.recipe_id, r.n);
  }

  const origin = (isDev(c.env) || !c.env.PUBLIC_ORIGIN ? new URL(c.req.url).origin : c.env.PUBLIC_ORIGIN).replace(/\/+$/, '');
  const recipes = rows.map(r => agentRecipe(r, votes.get(r.id) ?? 0, origin));

  if (agent) {
    const p = c.env.DB.prepare('INSERT INTO recipe_requests (agent_id, site, task_id, recipe_id, at) VALUES (?, ?, ?, ?, ?)')
      .bind(agent.id, site, found?.task.id ?? null, recipes[0]?.id ?? null, Date.now()).run().catch(() => undefined);
    const ctx = execCtx(c);
    if (ctx) ctx.waitUntil(p); else await p;
  }

  return c.json({
    ok: true,
    notice: AGENT_TEXT.recipeNotice,
    site,
    site_policy: { policy, guidance: AGENT_TEXT.policyGuidance[policy] },
    task: found ? { name: found.task.label, slug: found.task.slug, match: found.match } : null,
    recipes,
    blocked_sites: blockedSites,
    follow_up: recipes.length ? AGENT_TEXT.recipeFollowUp : null,
  });
});

export default app;
