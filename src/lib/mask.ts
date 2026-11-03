// STUB — owned by the privacy agent (BE-1), who replaces this file with the real implementation.
// The exported signatures below are the contract; keep them.
//
// Server-side second masking pass. Personal values -> labels ('[EMAIL]', '[PHONE]', '[CARD]', '[IBAN]',
// '[ACCOUNT]', '[ADDRESS]', '[POSTCODE]', '[NAME]', '[SSN]', '[DOB]', '[IP]'); secrets (API keys, passwords,
// tokens, cookies, JWTs, private keys, auth headers, secret-named object keys) -> '[SECRET]' (stripped).

export type MaskCounts = Record<string, number>;

export interface MaskResult<T> {
  value: T;
  counts: MaskCounts; // label -> number of replacements made by this pass
  total: number;
}

/** Mask one string. */
export function maskText(s: string): { text: string; counts: MaskCounts } {
  return { text: s, counts: {} };
}

/** Deep-mask any JSON value: every string value, plus values under secret-looking keys. Never mutates input. */
export function maskDeep<T>(value: T): MaskResult<T> {
  return { value, counts: {}, total: 0 };
}

/** Strip query string + fragment and mask path segments that look like ids/emails/tokens. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return maskText(url).text;
  }
}
