// Data for /recipes and /recipes/:site/:slug (slug = the specific task's slug, e.g. cancel-netflix-subscription). UI-3.
// Only tasks whose name is public (RULES.TASK_PUBLIC_MIN_CROWD) have public recipes.
// Everything returned here is derived, sanitized recipe data (never trace content); hidden JSON fields
// are stripped with publicSteps()/publicDeadEnds() from src/processing/recipes.ts.
import type { Bindings } from '../env';
import type { DeadEnd, RecipeRow, RecipeStep, SitePolicyRow, TaskRow } from '../types';
import { RULES } from '../lib/rules';
import { getSitePolicy } from '../processing/policies';
import { publicDeadEnds, publicSteps } from '../processing/recipes';
import { cached } from '../processing/snapshots';

export type CardStatus = 'trusted' | 'forming' | 'outdated' | 'blocked';
export type IndexStatus = 'all' | CardStatus;
export type TrustMark = 'o' | 'f' | 'h';

export interface RecipeCard {
  site: string;
  slug: string;
  task_id: string;
  title: string;
  upvotes: number;
  status: CardStatus;
  href: string;
  agents_succeeded: number;
  /** Failures since the last confirmed success (outdated recipes): one coral square each. */
  failures: number;
  median_steps: number | null;
  median_s: number | null;
  last_confirmed_at: number | null;
  outdated_at: number | null;
}

export interface RecipeIndex {
  items: RecipeCard[];
  counts: { trusted: number; forming: number; outdated: number; blocked: number };
  /** Everything the DB holds, before filters: lets the page tell "nothing yet" from "nothing matches". */
  total: number;
}

export interface RecipeVersionRef {
  version: number;
  status: RecipeRow['status'];
  href: string;
  /** When the version stopped being current: outdated_at when it went out of date, else updated_at. */
  ended_at: number | null;
  outdated: boolean;
}

export interface RecipeRelated {
  title: string;
  slug: string;
  status: CardStatus;
  href: string;
}

export interface RecipeDetail {
  kind: 'recipe';
  id: string;
  site: string;
  slug: string;
  task_id: string;
  title: string;
  upvotes: number;               // agents that followed this version and succeeded
  version: number;
  status: RecipeRow['status'];
  /** True when viewing an older version via ?v=; `current` then points at the live one. */
  is_current: boolean;
  current: RecipeVersionRef | null;
  steps: RecipeStep[];
  dead_ends: DeadEnd[];
  trust: TrustMark[];
  agents_succeeded: number;
  agents_failed: number;
  agents_handed_back: number;
  failures: number;
  median_steps: number | null;
  median_s: number | null;
  works_best_on: string | null;
  created_at: number;
  last_confirmed_at: number | null;
  outdated_at: number | null;
  policy: SitePolicyRow | null;
  previous: RecipeVersionRef[];
  related: RecipeRelated[];
}

export interface BlockedSite {
  kind: 'blocked';
  site: string;
  slug: string;
  title: string;
  policy: SitePolicyRow;
}

export type RecipePage = RecipeDetail | BlockedSite;

const SITE_RE = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Normalises a :site route param; null when it is not a plausible registrable domain. */
export function normalizeSite(raw: string | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase();
  return SITE_RE.test(s) ? s : null;
}

export const recipeHref = (site: string, slug: string, version?: number): string =>
  `/recipes/${encodeURIComponent(site)}/${encodeURIComponent(slug)}${version ? `?v=${version}` : ''}`;

export function parseTrust(json: string | null | undefined): TrustMark[] {
  try {
    const arr: unknown = json ? JSON.parse(json) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is TrustMark => x === 'o' || x === 'f' || x === 'h').slice(-RULES.RECIPE_TRUST_SQUARES);
  } catch {
    return [];
  }
}

/** Failed attempts since the last success (the run that marks a recipe out of date). */
export function trailingFailures(trust: TrustMark[], fallback: number): number {
  let n = 0;
  for (let i = trust.length - 1; i >= 0 && trust[i] !== 'o'; i--) if (trust[i] === 'f') n++;
  return n || fallback;
}

const cardStatus = (s: RecipeRow['status']): CardStatus | null =>
  s === 'trusted' || s === 'forming' || s === 'outdated' || s === 'blocked' ? s : null;

type CurrentRow = Pick<RecipeRow, 'site' | 'task_id' | 'slug' | 'title' | 'status' | 'agents_succeeded' | 'agents_failed' | 'median_steps' | 'median_s' | 'last_confirmed_at' | 'outdated_at' | 'trust_json'> & { upvotes: number };

const K = RULES.TASK_PUBLIC_MIN_CROWD;
/** The current (highest non-superseded) version per (task, site), for public tasks only. */
const CURRENT_JOIN = `JOIN (SELECT task_id, site, MAX(version) AS v FROM recipes WHERE status != 'superseded' GROUP BY task_id, site) m
         ON m.task_id = r.task_id AND m.site = r.site AND m.v = r.version
       JOIN tasks k ON k.id = r.task_id AND k.crowd >= ${K}`;

async function computeIndex(env: Bindings): Promise<RecipeCard[]> {
  const [rows, blockedSites] = await Promise.all([
    env.DB.prepare(
      `SELECT r.site, r.task_id, k.slug, k.label AS title, r.status, r.agents_succeeded, r.agents_failed, r.median_steps, r.median_s,
              r.last_confirmed_at, r.outdated_at, r.trust_json, COALESCE(u.n, 0) AS upvotes
       FROM recipes r ${CURRENT_JOIN}
       LEFT JOIN (SELECT recipe_id, COUNT(*) AS n FROM upvotes GROUP BY recipe_id) u ON u.recipe_id = r.id
       WHERE r.status != 'superseded'
       ORDER BY CASE r.status WHEN 'trusted' THEN 0 WHEN 'forming' THEN 1 WHEN 'outdated' THEN 2 ELSE 3 END,
                r.agents_succeeded DESC, r.last_confirmed_at DESC
       LIMIT 2000`,
    ).all<CurrentRow>(),
    // Blocked sites: one card each, titled with the public task agents most often attempted there.
    env.DB.prepare(
      `SELECT p.site,
              (SELECT k.slug FROM recipe_groups g JOIN tasks k ON k.id = g.task_id WHERE g.site = p.site AND k.crowd >= ${K} ORDER BY g.traces DESC LIMIT 1) AS slug,
              (SELECT k.label FROM recipe_groups g JOIN tasks k ON k.id = g.task_id WHERE g.site = p.site AND k.crowd >= ${K} ORDER BY g.traces DESC LIMIT 1) AS label
       FROM site_policies p WHERE p.policy = 'blocks' ORDER BY p.site`,
    ).all<{ site: string; slug: string | null; label: string | null }>(),
  ]);

  const blocked = new Set(blockedSites.results.map(b => b.site));
  const cards: RecipeCard[] = [];
  for (const r of rows.results) {
    if (blocked.has(r.site)) continue; // one card per blocked site, below
    const status = cardStatus(r.status);
    if (!status || status === 'blocked') continue;
    if (status === 'forming' && r.agents_succeeded < RULES.RECIPE_MIN_AGENTS_TO_PUBLISH) continue;
    const trust = parseTrust(r.trust_json);
    cards.push({
      site: r.site,
      slug: r.slug,
      task_id: r.task_id,
      title: r.title,
      upvotes: r.upvotes,
      status,
      href: recipeHref(r.site, r.slug),
      agents_succeeded: r.agents_succeeded,
      failures: status === 'outdated' ? trailingFailures(trust, r.agents_failed) : 0,
      median_steps: r.median_steps,
      median_s: r.median_s,
      last_confirmed_at: r.last_confirmed_at,
      outdated_at: r.outdated_at,
    });
  }
  for (const b of blockedSites.results) {
    const slug = b.slug ?? 'tasks';
    cards.push({
      site: b.site, slug, task_id: '', title: b.label ?? `Tasks on ${b.site}`, upvotes: 0, status: 'blocked', href: recipeHref(b.site, slug),
      agents_succeeded: 0, failures: 0, median_steps: null, median_s: null, last_confirmed_at: null, outdated_at: null,
    });
  }
  return cards;
}

export function parseIndexStatus(raw: string | undefined): IndexStatus {
  return raw === 'trusted' || raw === 'forming' || raw === 'outdated' || raw === 'blocked' ? raw : 'all';
}

/** Case-insensitive substring on site + task title (the same rule public/js/recipes.js applies client-side). */
export function matchesQuery(card: Pick<RecipeCard, 'site' | 'title'>, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return card.site.includes(needle) || card.title.toLowerCase().includes(needle);
}

export async function listRecipes(env: Bindings, opts: { q?: string; status?: IndexStatus } = {}): Promise<RecipeIndex> {
  const all = await cached(env, 'recipes:index', 45_000, () => computeIndex(env));
  const counts = { trusted: 0, forming: 0, outdated: 0, blocked: 0 };
  for (const c of all) counts[c.status]++;
  const status = opts.status ?? 'all';
  const items = all.filter(c => {
    // "Out of date" also lists blocked sites: both are paths that no longer work.
    const statusOk = status === 'all' || c.status === status || (status === 'outdated' && c.status === 'blocked');
    return statusOk && matchesQuery(c, opts.q ?? '');
  });
  return { items, counts, total: all.length };
}

function versionRef(r: Pick<RecipeRow, 'site' | 'slug' | 'version' | 'status' | 'outdated_at' | 'updated_at'>, current: boolean): RecipeVersionRef {
  return {
    version: r.version,
    status: r.status,
    href: recipeHref(r.site, r.slug, current ? undefined : r.version),
    ended_at: r.outdated_at ?? r.updated_at ?? null,
    outdated: r.outdated_at !== null,
  };
}

/**
 * The recipe page for (site, slug): the current version, or `version` when given (older versions stay readable).
 * Returns a BlockedSite when the site's policy is 'blocks' (we never show steps for those), null for unknown.
 */
export async function getRecipe(env: Bindings, siteRaw: string, slugRaw: string, version?: number): Promise<RecipePage | null> {
  const site = normalizeSite(siteRaw);
  const slug = (slugRaw ?? '').trim().toLowerCase();
  if (!site || !/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const [policy, taskRow] = await Promise.all([
    getSitePolicy(env, site),
    env.DB.prepare('SELECT * FROM tasks WHERE slug = ?').bind(slug).first<TaskRow>(),
  ]);
  const task = taskRow && taskRow.crowd >= K ? taskRow : null; // a private task's name never appears on a page
  if (policy?.policy === 'blocks') return { kind: 'blocked', site, slug, title: task?.label ?? `Tasks on ${site}`, policy };
  if (!task) return null;

  const current = await env.DB.prepare(
    "SELECT * FROM recipes WHERE task_id = ? AND site = ? AND status != 'superseded' ORDER BY version DESC LIMIT 1",
  ).bind(task.id, site).first<RecipeRow>();
  if (!current) return null;
  if (current.status === 'blocked') return policy ? { kind: 'blocked', site, slug, title: task.label, policy } : null;
  if (current.status === 'forming' && current.agents_succeeded < RULES.RECIPE_MIN_AGENTS_TO_PUBLISH) return null;

  let row = current;
  if (version !== undefined && version !== current.version) {
    const old = await env.DB.prepare('SELECT * FROM recipes WHERE task_id = ? AND site = ? AND version = ?').bind(task.id, site, version).first<RecipeRow>();
    if (!old) return null;
    row = old;
  }
  const isCurrent = row.id === current.id;

  const [prev, rel, votes] = await Promise.all([
    env.DB.prepare('SELECT site, slug, version, status, outdated_at, updated_at FROM recipes WHERE task_id = ? AND site = ? AND version < ? ORDER BY version DESC LIMIT 5')
      .bind(task.id, site, row.version).all<Pick<RecipeRow, 'site' | 'slug' | 'version' | 'status' | 'outdated_at' | 'updated_at'>>(),
    env.DB.prepare(
      `SELECT r.title, r.slug, r.status, r.agents_succeeded FROM recipes r ${CURRENT_JOIN}
       WHERE r.site = ? AND r.task_id != ? AND r.status IN ('trusted', 'forming', 'outdated')
       ORDER BY CASE r.status WHEN 'trusted' THEN 0 WHEN 'forming' THEN 1 ELSE 2 END, r.agents_succeeded DESC LIMIT 4`,
    ).bind(site, task.id).all<Pick<RecipeRow, 'title' | 'slug' | 'status' | 'agents_succeeded'>>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM upvotes WHERE recipe_id = ?').bind(row.id).first<{ n: number }>(),
  ]);

  const trust = parseTrust(row.trust_json);
  return {
    kind: 'recipe',
    id: row.id,
    site,
    slug: task.slug,
    task_id: row.task_id,
    title: task.label,
    upvotes: votes?.n ?? 0,
    version: row.version,
    status: row.status,
    is_current: isCurrent,
    current: isCurrent ? null : versionRef(current, true),
    steps: publicSteps(row.steps_json),
    dead_ends: publicDeadEnds(row.dead_ends_json),
    trust,
    agents_succeeded: row.agents_succeeded,
    agents_failed: row.agents_failed,
    agents_handed_back: row.agents_handed_back,
    failures: trailingFailures(trust, row.agents_failed),
    median_steps: row.median_steps,
    median_s: row.median_s,
    works_best_on: row.works_best_on,
    created_at: row.created_at,
    last_confirmed_at: row.last_confirmed_at,
    outdated_at: row.outdated_at,
    policy,
    previous: prev.results.map(p => versionRef(p, false)),
    related: rel.results.flatMap(r => {
      const status = cardStatus(r.status);
      if (!status || (status === 'forming' && r.agents_succeeded < RULES.RECIPE_MIN_AGENTS_TO_PUBLISH)) return [];
      return [{ title: r.title, slug: r.slug, status, href: recipeHref(site, r.slug) }];
    }),
  };
}
