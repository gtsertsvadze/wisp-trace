// Identifiers, tokens and hashing. Uses Web Crypto (available in Workers and Node >= 20).

const B32 = 'abcdefghijkmnpqrstuvwxyz23456789'; // no l, o, 0, 1
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomString(len: number, alphabet = B32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export const newId = (prefix: 'ag' | 'tr' | 'rc' | 'tk') => `${prefix}_${randomString(20)}`;
export const newApiKey = () => `wt_${randomString(40, B62)}`;
export const newOwnerToken = () => `wto_${randomString(40, B62)}`;

/** Short, readable claim code like 'qf7-29xk': 2 letters from the name + 1 digit, dash, 4 random. */
export function newClaimCode(name: string): string {
  const letters = (name.replace(/[^a-z]/g, '') + 'wt').slice(0, 2);
  return `${letters}${randomString(1, '23456789')}-${randomString(4)}`;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Opaque public key for a private id (e.g. feed rows), so trace ids never leave the server. */
export async function opaqueKey(id: string, salt = ''): Promise<string> {
  return (await sha256Hex(`${salt}:${id}`)).slice(0, 12);
}
