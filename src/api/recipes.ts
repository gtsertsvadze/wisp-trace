// Agent-facing recipe lookup: GET /api/v1/recipes?site=<domain or url>&task=<free text> | &type=<taxonomy id>
// Returns only derived, sanitized data (never trace content). Auth optional; authed lookups are logged.
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
import { isTaskTypeId } from '../lib/taxonomy';
import { HOUR, dayOf } from '../lib/time';
import { classifyTask } from '../processing/classify';
import { getSitePolicy } from '../processing/policies';
import { publicDeadEnds, publicSteps } from '../processing/recipes';

const app = new Hono<AppEnv>();

const Query = z.object({
  site: z.string().trim().min(1).max(500),
  task: z.string().trim().max(500).optional(),
  type: z.string().trim().max(64).optional(),
});

const SECURE_TEXTS = new Set<string>(Object.values(AGENT_TEXT.secureStep));

/** Agent-facing recipe shape. Texts are re-checked on the way out (defense in depth). */
function agentRecipe(r: RecipeRow, origin: string) {
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
    status: r.status,
    version: r.version,
    agents_succeeded: r.agents_succeeded,
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
  if (!parsed.success) return jsonError(c, 400, 'invalid_query', 'Pass site=<domain or url> and task=<text> or type=<taxonomy id>.');
  const { site: siteIn, task, type } = parsed.data;
  const agent = c.get('agent');

  const rl = await hit(c.env, `recipes:${agent ? agent.id : `ip:${await clientIpHash(c)}`}`, RULES.RECIPE_LOOKUPS_PER_HOUR, HOUR);
  if (!rl.ok) return jsonError(c, 429, 'rate_limited', 'Too many recipe lookups. Try again later.', { retry_after_s: Math.ceil((rl.resetAt - Date.now()) / 1000) });

  const site = registrableDomain(siteIn);
  if (!site) return jsonError(c, 400, 'invalid_site', 'site must be a domain or URL.');
  let taskType: string;
  if (type && isTaskTypeId(type)) taskType = type;
  else if (task) taskType = (await classifyTask(c.env, { description: task, sites: [site], type_hint: type })).task_type;
  else return jsonError(c, 400, type ? 'invalid_type' : 'missing_task', 'Pass task=<what your human asked for> or a valid type=<taxonomy id>.');

  const policyRow = await getSitePolicy(c.env, site);
  const policy: SitePolicy = policyRow?.policy ?? 'unknown';
  const rows = policy === 'blocks'
    ? []
    : (await c.env.DB.prepare(
      `SELECT * FROM recipes WHERE site = ? AND task_type = ? AND status IN ('trusted', 'forming')
       ORDER BY CASE status WHEN 'trusted' THEN 0 ELSE 1 END, agents_succeeded DESC, version DESC LIMIT 3`,
    ).bind(site, taskType).all<RecipeRow>()).results;

  const origin = (isDev(c.env) || !c.env.PUBLIC_ORIGIN ? new URL(c.req.url).origin : c.env.PUBLIC_ORIGIN).replace(/\/+$/, '');
  const recipes = rows.map(r => agentRecipe(r, origin));

  if (agent) {
    const p = c.env.DB.prepare('INSERT INTO recipe_requests (agent_id, site, task_type, recipe_id, at) VALUES (?, ?, ?, ?, ?)')
      .bind(agent.id, site, taskType, recipes[0]?.id ?? null, Date.now()).run().catch(() => undefined);
    const ctx = execCtx(c);
    if (ctx) ctx.waitUntil(p); else await p;
  }

  return c.json({
    ok: true,
    notice: AGENT_TEXT.recipeNotice,
    site,
    site_policy: { policy, guidance: AGENT_TEXT.policyGuidance[policy] },
    task_type: taskType,
    recipes,
  });
});

export default app;
