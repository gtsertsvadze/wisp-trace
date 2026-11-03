// STUB — owned by BE-3 (processing). Keep the exported signatures.
import type { Bindings } from '../env';
import type { SitePolicy, SitePolicyRow } from '../types';

export async function getSitePolicy(_env: Bindings, _site: string): Promise<SitePolicyRow | null> {
  return null;
}

export async function setSitePolicy(
  _env: Bindings, _site: string, _policy: SitePolicy, _note: string | null, _source: SitePolicyRow['source'] = 'manual',
): Promise<void> {}

/** Called by ingest when a trace has outcome.blocked_by_site. Marks the site 'blocks' once enough distinct agents report it. */
export async function reportBlocked(_env: Bindings, _site: string, _agentId: string): Promise<void> {}
