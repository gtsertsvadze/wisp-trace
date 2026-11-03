// Data for /recipes and /recipes/:site/:slug. Owned by UI-3.
// Everything returned here is derived, sanitized recipe data (never trace content); hidden JSON fields
// are stripped with publicSteps()/publicDeadEnds() from src/processing/recipes.ts.
import type { Bindings } from '../env';
import type { DeadEnd, RecipeRow, RecipeStep, SitePolicyRow } from '../types';
import { RULES } from '../lib/rules';
import { taskType, taskTypeBySlug } from '../lib/taxonomy';
import { getSitePolicy } from '../processing/policies';
import { publicDeadEnds, publicSteps } from '../processing/recipes';
import { cached } from '../processing/snapshots';

export type CardStatus = 'trusted' | 'forming' | 'outdated' | 'blocked';
export type IndexStatus = 'all' | CardStatus;
export type TrustMark = 'o' | 'f' | 'h';

export interface RecipeCard {
  site: string;
  slug: string;
  task_type: string;
  title: string;
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
  task_type: string;
  title: string;
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

type CurrentRow = Pick<RecipeRow, 'site' | 'task_type' | 'slug' | 'title' | 'status' | 'agents_succeeded' | 'agents_failed' | 'median_steps' | 'median_s' | 'last_confirmed_at' | 'outdated_at' | 'trust_json'>;

async function computeIndex(env: Bindings): Promise<RecipeCard[]> {
  const [rows, blockedSites] = await Promise.all([
    // The current (highest non-superseded) version per (site, task_type).
    env.DB.prepare(
      `SELECT r.site, r.task_type, r.slug, r.title, r.status, r.agents_succeeded, r.agents_failed, r.median_steps, r.median_s,
              r.last_confirmed_at, r.outdated_at, r.trust_json
       FROM recipes r
       JOIN (SELECT site, task_type, MAX(version) AS v FROM recipes WHERE status != 'superseded' GROUP BY site, task_type) m
         ON m.site = r.site AND m.task_type = r.task_type AND m.v = r.version
       WHERE r.status != 'superseded'
       ORDER BY CASE r.status WHEN 'trusted' THEN 0 WHEN 'forming' THEN 1 WHEN 'outdated' THEN 2 ELSE 3 END,
                r.agents_succeeded DESC, r.last_confirmed_at DESC`,
    ).all<CurrentRow>(),
    env.DB.prepare(
      `SELECT p.site, g.task_type
       FROM site_policies p
       LEFT JOIN (
         SELECT site, task_type FROM recipe_groups g1
         WHERE traces = (SELECT MAX(traces) FROM recipe_groups g2 WHERE g2.site = g1.site)
       ) g ON g.site = p.site
       WHERE p.policy = 'blocks'
       GROUP BY p.site ORDER BY p.site`,
    ).all<{ site: string; task_type: string | null }>(),
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
      task_type: r.task_type,
      title: r.title,
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
    // Title: the task agents most often attempted on the site (taxonomy text), else the generic one.
    const fromRecipe = rows.results.find(r => r.site === b.site);
    const tt = taskType(fromRecipe?.task_type ?? b.task_type);
    cards.push({
      site: b.site, slug: tt.slug, task_type: tt.id, title: tt.recipe, status: 'blocked', href: recipeHref(b.site, tt.slug),
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
  const tt = taskTypeBySlug((slugRaw ?? '').trim().toLowerCase());
  if (!site || !tt) return null;
  const policy = await getSitePolicy(env, site);
  if (policy?.policy === 'blocks') return { kind: 'blocked', site, slug: tt.slug, title: tt.recipe, policy };

  const current = await env.DB.prepare(
    "SELECT * FROM recipes WHERE site = ? AND slug = ? AND status != 'superseded' ORDER BY version DESC LIMIT 1",
  ).bind(site, tt.slug).first<RecipeRow>();
  if (!current) return null;
  if (current.status === 'blocked') return policy ? { kind: 'blocked', site, slug: tt.slug, title: tt.recipe, policy } : null;
  if (current.status === 'forming' && current.agents_succeeded < RULES.RECIPE_MIN_AGENTS_TO_PUBLISH) return null;

  let row = current;
  if (version !== undefined && version !== current.version) {
    const old = await env.DB.prepare('SELECT * FROM recipes WHERE site = ? AND slug = ? AND version = ?').bind(site, tt.slug, version).first<RecipeRow>();
    if (!old) return null;
    row = old;
  }
  const isCurrent = row.id === current.id;

  const [prev, rel] = await Promise.all([
    env.DB.prepare('SELECT site, slug, version, status, outdated_at, updated_at FROM recipes WHERE site = ? AND task_type = ? AND version < ? ORDER BY version DESC LIMIT 5')
      .bind(site, row.task_type, row.version).all<Pick<RecipeRow, 'site' | 'slug' | 'version' | 'status' | 'outdated_at' | 'updated_at'>>(),
    env.DB.prepare(
      `SELECT r.title, r.slug, r.status, r.agents_succeeded FROM recipes r
       JOIN (SELECT site, task_type, MAX(version) AS v FROM recipes WHERE status != 'superseded' GROUP BY site, task_type) m
         ON m.site = r.site AND m.task_type = r.task_type AND m.v = r.version
       WHERE r.site = ? AND r.task_type != ? AND r.status IN ('trusted', 'forming', 'outdated')
       ORDER BY CASE r.status WHEN 'trusted' THEN 0 WHEN 'forming' THEN 1 ELSE 2 END, r.agents_succeeded DESC LIMIT 4`,
    ).bind(site, row.task_type).all<Pick<RecipeRow, 'title' | 'slug' | 'status' | 'agents_succeeded'>>(),
  ]);

  const trust = parseTrust(row.trust_json);
  return {
    kind: 'recipe',
    id: row.id,
    site,
    slug: row.slug,
    task_type: row.task_type,
    title: row.title,
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
