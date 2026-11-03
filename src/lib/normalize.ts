// STUB — owned by BE-2 (agent API + ingest). Keep the exported signatures.

/** 'https://www.shop.fitlane.co.uk/a?b' -> 'fitlane.co.uk'. Returns null when it isn't a domain. */
export function registrableDomain(urlOrHost: string): string | null {
  try {
    const host = new URL(urlOrHost.includes('://') ? urlOrHost : `https://${urlOrHost}`).hostname.toLowerCase();
    return host.split('.').slice(-2).join('.') || null;
  } catch {
    return null;
  }
}

/** 'anthropic/claude-sonnet-4-5-20250929' -> 'claude-sonnet-4.5' */
export function normalizeModel(s: string | null | undefined): string {
  return (s || 'unknown').toLowerCase().slice(0, 40);
}

/** 'openclaw' -> 'OpenClaw' */
export function normalizeApp(s: string | null | undefined): string {
  return (s || 'Unknown').slice(0, 24);
}
