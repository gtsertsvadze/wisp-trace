// Per-site agent policies. 'blocks' sites get no recipes; agents are told to hand back.
import type { Bindings } from '../env';
import type { SitePolicy, SitePolicyRow } from '../types';
import { RULES } from '../lib/rules';

export async function getSitePolicy(env: Bindings, site: string): Promise<SitePolicyRow | null> {
  return env.DB.prepare('SELECT * FROM site_policies WHERE site = ?').bind(site).first<SitePolicyRow>();
}

export async function setSitePolicy(
  env: Bindings, site: string, policy: SitePolicy, note: string | null, source: SitePolicyRow['source'] = 'manual',
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO site_policies (site, policy, source, note, reports, updated_at) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(site) DO UPDATE SET policy = excluded.policy, source = excluded.source, note = excluded.note, updated_at = excluded.updated_at`,
    ).bind(site, policy, source, note, now),
    // Recipes for the site must be re-evaluated (blocked / unblocked).
    env.DB.prepare('UPDATE recipe_groups SET dirty = 1 WHERE site = ?').bind(site),
  ]);
}

/** Called by ingest when a trace has outcome.blocked_by_site. Marks the site 'blocks' once enough distinct agents report it. */
export async function reportBlocked(env: Bindings, site: string, _agentId: string): Promise<void> {
  const row = await env.DB.prepare(
    'SELECT COUNT(DISTINCT agent_id) AS n FROM traces WHERE site = ? AND blocked_by_site = 1',
  ).bind(site).first<{ n: number }>();
  const reports = row?.n ?? 0;
  const existing = await getSitePolicy(env, site);
  const now = Date.now();
  // Manual decisions win; we only keep the report count current.
  const manualKeep = existing?.source === 'manual' && (existing.policy === 'allows' || existing.policy === 'blocks');
  if (manualKeep || (existing?.policy === 'blocks' && reports < RULES.BLOCK_REPORTS_TO_MARK)) {
    await env.DB.prepare('UPDATE site_policies SET reports = ?, updated_at = ? WHERE site = ?').bind(reports, now, site).run();
    return;
  }
  if (reports >= RULES.BLOCK_REPORTS_TO_MARK) {
    if (existing?.policy === 'blocks') {
      await env.DB.prepare('UPDATE site_policies SET reports = ?, updated_at = ? WHERE site = ?').bind(reports, now, site).run();
      return;
    }
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO site_policies (site, policy, source, note, reports, updated_at) VALUES (?, 'blocks', 'reported', NULL, ?, ?)
         ON CONFLICT(site) DO UPDATE SET policy = 'blocks', source = 'reported', reports = excluded.reports, updated_at = excluded.updated_at`,
      ).bind(site, reports, now),
      env.DB.prepare('UPDATE recipe_groups SET dirty = 1 WHERE site = ?').bind(site),
    ]);
    return;
  }
  await env.DB.prepare(
    `INSERT INTO site_policies (site, policy, source, note, reports, updated_at) VALUES (?, 'unknown', 'reported', NULL, ?, ?)
     ON CONFLICT(site) DO UPDATE SET reports = excluded.reports, updated_at = excluded.updated_at`,
  ).bind(site, reports, now).run();
}
