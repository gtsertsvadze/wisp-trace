// Injection / secret / circumvention firewall for anything derived from traces that reaches other
// agents or public pages (recipe steps, dead ends, notes). When in doubt, reject: callers drop the text.

import type { Sensitive } from '../types';

// Control chars, zero-width, bidi overrides, BOM, interlinear annotations and Unicode tag chars.
const NON_PRINTABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/u;

const REJECT: RegExp[] = [
  /\b(ignore|disregard|forget|override|skip)\b.{0,40}\b(previous|prior|above|all|earlier|any|preceding|your)\b.{0,30}\b(instructions?|prompts?|rules|directions|guidelines|messages?)\b/i,
  /\bsystem\s*prompt\b/i,
  /\byou\s+are\s+now\b/i,
  /\bact\s+as\b/i,
  /\bas\s+an?\s+(ai|llm|language model|assistant)\b/i,
  /\b(assistant|system|user|human)\s*:/i,
  /\bdeveloper\s+mode\b/i,
  /\bnew\s+instructions?\b/i,
  /\b(important|note to (the )?(ai|agent|assistant)|attention)\s*:/i,
  /\bjailbreak\w*\b/i,
  /\bprompt\s+injection\b/i,
  /<\|?\s*(im_start|im_end|endoftext|system)\b/i,
  /\b(send|post|upload|reveal|share|email|exfiltrate|leak|print|paste|forward|transmit|output)\b.{0,40}\b(api[ _-]?keys?|keys?|tokens?|passwords?|credentials?|cookies?|secrets?|session ids?)\b/i,
  /\b(curl|wget|powershell|pwsh|bash|zsh|cmd\.exe|invoke-webrequest|invoke-expression|iex|sudo|chmod|nc|netcat)\b/i,
  /\brm\s+-[rf]+\b/i,
  /\|\s*(sh|bash)\b/i,
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,                          // emails
  /\[[A-Z][A-Z0-9_]{2,}\]/,                               // [EMAIL], [NAME], [CARD]… masks
];

// Checked on the cleaned text only (URLs and code fences would otherwise trip it).
const BLOB = [/[A-Za-z0-9+/=_-]{32,}/, /\b[a-f0-9]{24,}\b/i];

const CIRCUMVENTION = [
  /\b(re|h)?captcha\w*\b/i,
  /\bturnstile\b/i,
  /\bcloudflare\b.{0,20}\b(challenge|check|block|protection)\b/i,
  /\bbot[- ]?(detection|check|protection|block\w*|wall)\b/i,
  /\banti[- ]?bot\b/i,
  /\bnot a robot\b/i,
  /\bprox(y|ies)\b/i,
  /\bresidential\s+ips?\b/i,
  /\bvpns?\b/i,
  /\brotat\w*\s+(the\s+)?ips?\b/i,
  /\bip\s+rotation\b/i,
  /\buser[- ]?agents?\b/i,
  /\bspoof\w*\b/i,
  /\bfingerprint\w*\b/i,
  /\bheadless\b/i,
  /\bstealth\w*\b/i,
  /\bbypass\w*\b/i,
  /\b(evade|evading|evasion|evasive)\b/i,
  /\brate[- ]?limit\w*\b.{0,30}\b(evad\w*|evasion|avoid\w*|bypass\w*|around|circumvent\w*|dodg\w*)\b/i,
  /\b(evad\w*|avoid\w*|bypass\w*|around|circumvent\w*|dodg\w*)\b.{0,30}\brate[- ]?limit/i,
  /\bsolv\w*\s+(the\s+)?(challenge|puzzle)\b/i,
  /\bcircumvent\w*\b/i,
];

function clean(s: string): string {
  return s
    .replace(/```[a-z0-9_-]*\n?/gi, ' ')                 // code fence markers (content stays, so filters still see it)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')                // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')             // links -> text
    .replace(/<[^>]*>/g, ' ')                             // html tags
    .replace(/\b(?:[a-z][a-z0-9+.-]*):\/\/\S+/gi, ' ')    // absolute urls (relative paths stay)
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/\b(?:javascript|data|file|mailto):\S+/gi, ' ')
    .replace(/`+/g, '')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2').replace(/(\S)[*_](?=\s|$|[.,;:!?])/g, '$1')
    .replace(/(^|\n)\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+(.*?)["'“”‘’]+$/, '$1')          // quotes wrapping the whole thing
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > maxLen * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–-]+$/, '')}…`;
}

/** Plain, safe step text or null when the input looks like an instruction, secret, command or mask. */
export function sanitizeStepText(s: string | null | undefined, maxLen = 120): string | null {
  if (typeof s !== 'string' || !s) return null;
  const raw = s.normalize('NFKC');
  if (NON_PRINTABLE.test(raw)) return null;
  if (REJECT.some(r => r.test(raw))) return null;
  const out = clean(raw);
  if (out.length < 2 || !/[a-z]/i.test(out)) return null;
  if (REJECT.some(r => r.test(out)) || BLOB.some(r => r.test(out))) return null;
  return truncate(out, maxLen);
}

/** True when the text is about getting around bot checks, blocks or rate limits. Such text is never published. */
export function isCircumvention(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.normalize('NFKC');
  return CIRCUMVENTION.some(r => r.test(t));
}

const CREDENTIALS = /\b(sign(s|ed|ing)?[- ]?in|log(s|ged|ging)?[- ]?in|login|log[- ]?on|passwords?|passcodes?|passphrase|2fa|two[- ]factor|mfa|otp|one[- ]time (code|password|passcode)|verification code|security code|authenticat\w*|pin code)\b/i;
const PAYMENT = /\b(pay|pays|paid|paying|payments?|checkout|check out|cards?|billing|cvv|cvc|iban|sort code|bank details|account number|purchase now|place order)\b/i;
const PERSONAL = /\[(NAME|FULL_NAME|FIRST_NAME|LAST_NAME|ADDRESS|EMAIL|PHONE|DOB|POSTCODE|ZIP|PASSPORT|ID_NUMBER|SSN)\w*\]/;

export interface SecureCheckable {
  sensitive?: Sensitive | string | null;
  action?: string | null;
  target?: string | null;
  text?: string | null;
  error?: string | null;
}

/** Steps touching credentials, payment or personal data get fixed AGENT_TEXT.secureStep text instead of trace text. */
export function secureKind(step: SecureCheckable): Sensitive | null {
  if (step.sensitive === 'credentials' || step.sensitive === 'payment' || step.sensitive === 'personal') return step.sensitive;
  const text = [step.action, step.target, step.text].filter(Boolean).join(' ');
  if (!text) return null;
  if (CREDENTIALS.test(text)) return 'credentials';
  if (PAYMENT.test(text)) return 'payment';
  if (PERSONAL.test(text)) return 'personal';
  return null;
}
