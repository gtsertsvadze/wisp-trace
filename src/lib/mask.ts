// Privacy core. Personal values -> labels ('[EMAIL]', '[PHONE]', ...), secrets -> '[SECRET]'.
// Runs on the agent (public/skill/wisptrace.mjs and wisptrace.py are faithful ports of THIS file: same rule
// table, same sources, same order; test/mask.test.ts checks parity) and again on the server before storage.
//
// Design notes
// - Every rule is a regex plus the capture group that gets replaced (0 = whole match) and an optional validator
//   (Luhn, mod-97, digit counts). Only that group is replaced, so context words ("sort code", "Dear") survive.
// - Labels never re-match: value patterns cannot start with '[' or carry a (?!\[LABEL\]) guard, and maskText
//   iterates to a fixed point, so masking twice gives the same output.
// - Linear time: leading character runs are anchored with a negative lookbehind so a run is only tried from its
//   start; there are no nested unbounded quantifiers that can backtrack. Cheap prefilters skip rules that need
//   a digit / '@' / ':' etc. Regexes are portable to Python `re` (fixed-width lookbehinds, no \p, no named
//   groups, no \s: explicit [ \t] classes so JS and Python behave the same).

export type MaskCounts = Record<string, number>;

export interface MaskResult<T> {
  value: T;
  counts: MaskCounts; // label -> number of replacements made by this pass
  total: number;
}

/** Known personal values recorded by the agent, by label: { "[NAME]": ["Mira Kovacs"], "[EMAIL]": [...] }. */
export type PrivateValues = Record<string, string[]>;

export interface MaskOptions {
  /** Exact values masked (case-insensitively, on word boundaries) before any pattern. Client-side only. */
  privateValues?: PrivateValues | null;
}

export const MASK_VERSION = '0.1.0';

export const LABELS = {
  EMAIL: '[EMAIL]',
  PHONE: '[PHONE]',
  CARD: '[CARD]',
  IBAN: '[IBAN]',
  ACCOUNT: '[ACCOUNT]',
  SSN: '[SSN]',
  DOB: '[DOB]',
  POSTCODE: '[POSTCODE]',
  ADDRESS: '[ADDRESS]',
  NAME: '[NAME]',
  IP: '[IP]',
  SECRET: '[SECRET]',
} as const;

const LABEL_ONLY = /^\[[A-Z][A-Z_]{1,23}\]$/;

// ---------------------------------------------------------------------------
// Pattern building blocks (keep byte-identical with the ports)
// ---------------------------------------------------------------------------

/** Case-insensitive literal for use inside an otherwise case-sensitive regex. ' ' becomes `sep`. */
function ci(w: string, sep = '[ \\t]+'): string {
  let out = '';
  for (const c of w) {
    if (c === ' ') out += sep;
    else if (c === '.') out += '\\.';
    else if (/[A-Za-z]/.test(c)) out += `[${c.toLowerCase()}${c.toUpperCase()}]`;
    else out += c;
  }
  return out;
}
const kws = (list: string[], sep?: string) => list.map(w => ci(w, sep)).join('|');

const NOT_LABEL = String.raw`(?!\[[A-Z]+\])`;
const UP = String.raw`A-ZÀ-Þ`;
const LO = String.raw`a-zß-ÿ`;
const NW = String.raw`[${UP}](?:'[${UP}])?[${LO}]+(?:[${UP}][${LO}]+)?(?:-[${UP}][${LO}]+)?`;
const PARTICLE = '(?:van|von|de|der|den|da|di|du|del|della|la|le|bin|al|ibn)';
const NAMEVAL = String.raw`${NW}(?:[ \t]+(?:${PARTICLE}[ \t]+)?${NW}){0,2}`;
const CTX_SEP = String.raw`[^0-9A-Za-z\r\n]{0,6}(?:(?:is|was)[^0-9A-Za-z\r\n]{1,4})?`;

const STRONG_KEYS = String.raw`password|passwd|pwd|passcode|passphrase|secret|api[_\-]?key|apikey|access[_\-]?key|private[_\-]?key|client[_\-]?secret`;
const WEAK_KEYS = String.raw`token|session(?:[_\-]?id)?|sessid|sid|sig|signature|auth|otp|code_verifier|credentials?|cookie`;
const KEY_PREFIX = String.raw`(?<![A-Za-z0-9_\-])((?:[A-Za-z0-9]+[_\-])*`;
const NOT_A_VALUE = String.raw`(?:required|incorrect|invalid|wrong|correct|hidden|reset|changed|updated|accepted|rejected|missing|empty|field|not|too|strong|weak|saved|set|ok|manager|protected|masked|redacted|none|null|n/a)(?![A-Za-z0-9])`;
// Words that commonly follow "password"/"pin" in prose and are never the value itself ("password must", "pin code").
const PROSE_STOP = String.raw`(?:again|also|back|been|before|below|above|board|button|cannot|change|check|code|confirm(?:ation|ed)?|dialog|does|done|email|entered|entry|error|expired|expiry|fields|first|form|from|hash|here|hint|info|input|into|item|items|last|later|length|link|login|match(?:es)?|message|mismatch|modal|must|need(?:s|ed)?|never|number|once|only|option|page|policy|popup|post|posts|prompt|recovery|requirements?|rules|same|screen|section|sent|settings?|should|shown|step|strength|successfully|tabs?|text|that|their|them|then|there|these|this|those|twice|typed|unchanged|username|value|visible|were|what|when|where|which|will|with|works?|would|your)(?![A-Za-z0-9])`;

const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)';
const DATE = String.raw`[0-9]{4}[\-/.][0-9]{1,2}[\-/.][0-9]{1,2}|[0-9]{1,2}[\-/.][0-9]{1,2}[\-/.][0-9]{2,4}|[0-9]{1,2}(?:st|nd|rd|th)?[ \t]+(?:of[ \t]+)?${MON}[a-z]*\.?,?[ \t]+[0-9]{4}|${MON}[a-z]*\.?[ \t]+[0-9]{1,2}(?:st|nd|rd|th)?,?[ \t]+[0-9]{4}|(?:19|20)[0-9]{2}`;

const H = '[0-9a-f]{1,4}';
const IPV6 = [
  `(?:${H}:){7}${H}`, `(?:${H}:){1,7}:`, `(?:${H}:){1,6}:${H}`, `(?:${H}:){1,5}(?::${H}){1,2}`,
  `(?:${H}:){1,4}(?::${H}){1,3}`, `(?:${H}:){1,3}(?::${H}){1,4}`, `(?:${H}:){1,2}(?::${H}){1,5}`,
  `${H}:(?::${H}){1,6}`, `:(?::${H}){1,7}`,
].join('|');
const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';

const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR';
const EN_STREET = 'Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Place|Pl|Way|Terrace|Ter|Close|Crescent|Cres|Parkway|Pkwy|Highway|Hwy|Square|Sq|Gardens|Gdns|Grove|Mews|Row|Circle|Cir|Trail|Trl|Walk|Alley|Plaza';
const LATIN_PARTICLES = String.raw`(?:(?:de|du|des|la|le|les|del|della|delle|dei|di|da|do|dos|das)[ \t]+|[ldLD]')*`;

/** [id, label, source, flags ('' | 'i'), group replaced (0 = whole match), prefilter, validator] */
export type MaskRuleDef = [id: string, label: string, source: string, flags: string, group: number, need: string, check: string];

/** Prefilter `need`: 'D' = has a digit, '' = always run, anything else = substring that must be present. */
export const MASK_PATTERNS: MaskRuleDef[] = [
  // ---- secrets ---------------------------------------------------------------------------------------
  ['pem', '[SECRET]', String.raw`-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z0-9 ]*PRIVATE KEY-----|(?![\s\S]))`, '', 0, 'PRIVATE KEY', ''],
  ['url_credentials', '[SECRET]', String.raw`(?<![a-z0-9+.\-])([a-z][a-z0-9+.\-]{1,15}://)([^ \t\r\n/?#@:'"<>]{1,128}:[^ \t\r\n/?#@'"<>]{1,256})@`, 'i', 2, '@', ''],
  ['auth_header', '[SECRET]', String.raw`(?<![A-Za-z0-9\-])((?:proxy-)?authorization|set-cookie|cookie|x-api-key|x-auth-token|x-access-token|x-csrf-token|api-key)(\\?["']?[ \t]*[:=][ \t]*\\?["']?)${NOT_LABEL}([^ \t\r\n"'\\][^\r\n"'\\]*)`, 'i', 3, '', ''],
  ['auth_scheme', '[SECRET]', String.raw`(?<![A-Za-z0-9])((?:[Bb]earer|BEARER|[Bb]asic|BASIC|[Tt]oken|TOKEN)[ \t]+)${NOT_LABEL}([A-Za-z0-9\-._~+/]{8,}=*)(?![A-Za-z0-9\-._~+/=])`, '', 2, '', 'opaque'],
  ['api_key', '[SECRET]', String.raw`(?<![A-Za-z0-9_\-])(?:sk-ant-[A-Za-z0-9_\-]{16,}|sk-(?:proj-|svcacct-|live-|test-)?[A-Za-z0-9_\-]{20,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_\-]{16,}|xox[abprs]-[A-Za-z0-9\-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[0-9A-Za-z_\-]{35}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{36}|SG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}|eyJ[A-Za-z0-9_\-]{5,}\.eyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]*)(?![A-Za-z0-9_\-])`, '', 0, '', ''],
  ['kv_quoted', '[SECRET]', String.raw`${KEY_PREFIX}(?:${STRONG_KEYS}|${WEAK_KEYS}))\\?["']?[ \t]*[:=][ \t]*\\?(["'])${NOT_LABEL}([^"'\\\r\n]+)\\?\2`, 'i', 3, '', ''],
  ['kv_equals', '[SECRET]', String.raw`${KEY_PREFIX}(?:${STRONG_KEYS}|${WEAK_KEYS}))=${NOT_LABEL}([^ \t\r\n&"'<>;,\\]+)`, 'i', 2, '=', ''],
  ['kv_colon', '[SECRET]', String.raw`${KEY_PREFIX}(?:${STRONG_KEYS}))(?:[ \t]*:[ \t]*|[ \t]+(?:is|was)[ \t]+)(?!\[[A-Z]+\]|${NOT_A_VALUE})([^ \t\r\n"'<>,;\\]+)`, 'i', 2, '', ''],
  // "<key> <value>" in prose: "entered password hunter22". Single space, value of 4+ chars that is not a stop word.
  ['kv_prose', '[SECRET]', String.raw`(?<![A-Za-z0-9_\-])((?:password|passcode|passphrase|pin)[ \t])(?!\[[A-Z]+\]|${NOT_A_VALUE}|${PROSE_STOP})([^ \t\r\n"'<>,;\\]{4,})`, 'i', 2, '', ''],
  ['cvv', '[SECRET]', String.raw`(?<![A-Za-z])(cvv2?|cvc2?|csc|security[ \t]+code|card[ \t]+verification(?:[ \t]+(?:code|value|number))?)(?![A-Za-z])([^0-9\r\n]{0,16}?)([0-9]{3,4})(?![0-9]|[ \-][0-9])`, 'i', 3, 'D', ''],
  ['otp', '[SECRET]', String.raw`(?<![A-Za-z])((?:one[ \t\-]?time[ \t]+(?:pass(?:word|code)?|code|pin)|otp|totp|2fa|mfa)(?:[ \t]+code)?|(?:verification|security|authenticat(?:ion|or)|sms|login|sign[ \t\-]?in|access|two[ \t\-]factor)[ \t]+code|pin(?:[ \t]+(?:code|number))?)(?![A-Za-z])([^0-9\r\n]{0,24}?)([0-9]{4,8}|[0-9]{3}[ \-][0-9]{3})(?![0-9]|[ \-][0-9])`, 'i', 3, 'D', ''],

  // ---- personal data ---------------------------------------------------------------------------------
  ['email', '[EMAIL]', String.raw`(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]{1,64}@(?:[A-Za-z0-9\-]{1,63}\.)+(?!(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|html?|txt|pdf|zip)(?![A-Za-z0-9\-]))[A-Za-z]{2,24}(?![A-Za-z0-9\-])`, '', 0, '@', ''],
  ['iban', '[IBAN]', String.raw`(?<![A-Za-z0-9])[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![A-Za-z0-9])`, '', 0, 'D', 'iban'],
  ['dob', '[DOB]', String.raw`(?<![A-Za-z])(date[ \t_\-]?of[ \t_\-]?birth|d\.o\.b\.?|dob|birth[ \t_\-]?date|birthday|born(?:[ \t]+(?:on|in))?)(?![A-Za-z])(${CTX_SEP})(${DATE})(?![0-9])`, 'i', 3, 'D', ''],
  ['account', '[ACCOUNT]', String.raw`(?<![A-Za-z])((?:bank[ \t]+)?(?:account|acct|a/c)(?:[ \t]*(?:number|num|no\.?|#))?|routing(?:[ \t]*(?:number|num|no\.?|#))?|aba(?:[ \t]+(?:number|routing))?|sort[ \t_\-]?code|bsb|transit[ \t]+number)(?![A-Za-z])(${CTX_SEP})([0-9]{2}[ \-][0-9]{2}[ \-][0-9]{2}|[0-9][0-9 \-]{4,22}[0-9])(?![0-9])`, 'i', 3, 'D', 'account'],
  ['ssn_context', '[SSN]', String.raw`(?<![A-Za-z])(ssn|ss#|social[ \t]+security(?:[ \t]+(?:number|no\.?|#))?)(?![A-Za-z])([^0-9\r\n]{0,12}?)([0-9]{3}[ \-]?[0-9]{2}[ \-]?[0-9]{4})(?![0-9])`, 'i', 3, 'D', ''],
  ['ssn', '[SSN]', String.raw`(?<![0-9\-])(?!000|666|9[0-9][0-9])[0-9]{3}-(?!00)[0-9]{2}-(?!0000)[0-9]{4}(?![0-9\-])`, '', 0, 'D', ''],
  ['uk_nino', '[SSN]', String.raw`(?<![A-Za-z0-9])(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z][ \t]?[0-9]{2}[ \t]?[0-9]{2}[ \t]?[0-9]{2}[ \t]?[A-D](?![A-Za-z0-9])`, '', 0, 'D', ''],
  ['card', '[CARD]', String.raw`(?<![A-Za-z0-9\-.])[2-6][0-9]{3}(?:[ \-]?[0-9]){9,15}(?![A-Za-z0-9\-]|\.[0-9])`, '', 0, 'D', 'luhn'],
  ['ipv6', '[IP]', String.raw`(?<![A-Za-z0-9_:.])(?:${IPV6})(?![A-Za-z0-9_:]|\.[A-Za-z0-9])`, 'i', 0, ':', ''],
  ['ipv4', '[IP]', String.raw`(?<![A-Za-z0-9_.\-])(?<![A-Za-z]/)(?:${OCTET}\.){3}${OCTET}(?![A-Za-z0-9_\-]|\.[0-9])`, '', 0, '.', ''],
  ['phone_intl', '[PHONE]', String.raw`(?<![A-Za-z0-9+])\+[1-9](?:[ \t.\-]?\(?[0-9]+\)?)+`, '', 0, '+', 'phone'],
  ['phone_context', '[PHONE]', String.raw`(?<![A-Za-z])((?:phone|tel|telephone|mobile|cell|whatsapp|sms|fax|contact[ \t]+number|ph|call(?:[ \t]+me)?(?:[ \t]+(?:at|on))?|text(?:[ \t]+me)?(?:[ \t]+(?:at|on))?)(?:[ \t]*(?:number|no\.?|#))?)(?![A-Za-z])([^0-9A-Za-z\r\n+(]{0,6}(?:(?:is|was)[^0-9A-Za-z\r\n+(]{1,4})?)(\+?\(?[0-9][0-9 \t().\-]{6,20}[0-9])(?![0-9])`, 'i', 3, 'D', 'phone'],
  ['phone_national', '[PHONE]', String.raw`(?<![A-Za-z0-9.+\-/:#$£€_])(?:\([0-9]{2,5}\)[ \t.\-]?[0-9]{3,4}[ \t.\-]?[0-9]{3,4}|[0-9]{3}([.\-])[0-9]{3}\1[0-9]{4}|[0-9]{3} [0-9]{3} [0-9]{4}|0[0-9]{1,4}(?:[ \t.\-][0-9]{2,4}){2,4}|0[0-9]{3,4}[ \t.\-][0-9]{5,7})(?![A-Za-z0-9_\-]|[.,:/][0-9])`, '', 0, 'D', 'phone'],
  ['postcode_uk', '[POSTCODE]', String.raw`(?<![A-Za-z0-9])(?:[A-PR-UWYZ][A-HK-Y]?[0-9][A-Z0-9]?[ \t]?[0-9][ABD-HJLNP-UW-Z]{2}|GIR[ \t]?0AA)(?![A-Za-z0-9])`, '', 0, 'D', ''],
  ['zip_state', '[POSTCODE]', String.raw`(?<![A-Za-z])(${US_STATES})(,?[ \t]+)([0-9]{5}(?:-[0-9]{4})?)(?![0-9\-])`, '', 3, 'D', ''],
  ['postcode_context', '[POSTCODE]', String.raw`(?<![A-Za-z])(zip(?:[ \t_\-]?code)?|post(?:al)?[ \t_\-]?code|postcode|eircode|plz)(?![A-Za-z])(${CTX_SEP})([0-9]{5}(?:-[0-9]{4})?|[A-Z]{1,2}[0-9][A-Z0-9]?[ \t]?[0-9][A-Z]{2}|[A-Z][0-9][A-Z][ \t]?[0-9][A-Z][0-9]|[0-9]{3}-[0-9]{4}|[0-9]{2}-[0-9]{3}|[0-9]{4,6})(?![A-Za-z0-9])`, 'i', 3, 'D', ''],
  ['address_en', '[ADDRESS]', String.raw`(?<![A-Za-z0-9\-])[0-9]{1,5}[A-Za-z]?(?:[\-/][0-9]{1,5}[A-Za-z]?)?,?[ \t]+(?:[A-Z][a-z']+\.?[ \t]+){1,4}(?:${EN_STREET})(?![A-Za-z])\.?`, '', 0, 'D', ''],
  ['address_number_first', '[ADDRESS]', String.raw`(?<![A-Za-z0-9\-])[0-9]{1,4}(?:[ \t]?(?:bis|ter|[A-Za-z]))?,?[ \t]+(?:${kws(['rue', 'avenue', 'boulevard', 'bd', 'chemin', 'allee', 'impasse', 'quai', 'calle', 'carrer', 'avenida', 'rua', 'via', 'viale', 'piazza', 'corso'])})[ \t]+${LATIN_PARTICLES}[${UP}][${LO}'\-]+(?:[ \t]+(?:(?:de|du|des|la|le|les|del|di|da|do)[ \t]+)?[${UP}][${LO}'\-]+){0,3}`, '', 0, 'D', ''],
  ['address_name_first', '[ADDRESS]', String.raw`(?<![A-Za-z0-9\-])(?:Via|Viale|Piazza|Corso|Calle|Carrer|Avenida|Rua|Plaza|Paseo|Travessa)[ \t]+${LATIN_PARTICLES}[${UP}][${LO}'\-]+(?:[ \t]+[${UP}][${LO}'\-]+){0,2},?[ \t]+[0-9]{1,4}[A-Za-z]?(?![A-Za-z0-9\-])`, '', 0, 'D', ''],
  ['address_de', '[ADDRESS]', String.raw`(?<![A-Za-z0-9\-])[${UP}][${LO}\-]*(?:straße|strasse|str\.|weg|gasse|platz|allee|damm|ufer|chaussee)[ \t]+[0-9]{1,4}[a-z]?(?![A-Za-z0-9\-])`, '', 0, 'D', ''],
  ['name_intro', '[NAME]', String.raw`(?<![A-Za-z])((?:${kws(['my name is', "my name's", 'my full name is', 'his name is', 'her name is', 'their name is', "i'm called", 'i am called'])})[ \t]+)(${NAMEVAL})`, '', 2, '', ''],
  ['name_field', '[NAME]', String.raw`(?<![A-Za-z0-9])(${kws(['full name', 'first name', 'last name', 'given name', 'family name', 'middle name', 'maiden name', 'legal name', 'customer name', 'contact name', 'guest name', 'passenger name', 'traveller name', 'traveler name', 'recipient name', 'cardholder name', 'card holder name', 'account holder name', 'account holder', 'billing name', 'shipping name', 'your name', 'surname', 'name on card', 'cardholder', 'attn'], '[ \\t_\\-]?')})(?![A-Za-z])(\\?["']?[ \t]*[:=][ \t]*\\?["']?)(${NAMEVAL})`, '', 3, '', ''],
  ['name_label', '[NAME]', String.raw`(?<![A-Za-z0-9"'_\-])(?<![A-Za-z0-9][ \t])((?:[Nn]ame|NAME)[ \t]*:[ \t]*)(${NAMEVAL})`, '', 2, '', ''],
  ['name_dear', '[NAME]', String.raw`(?<![A-Za-z])((?:[Dd]ear|DEAR)[ \t]+)(?!(?:Mr|Mrs|Ms|Mx|Miss|Dr|Prof|Sir|Madam|Customer|Client|Member|Guest|Friend|Team|All|Valued|Colleague|Colleagues|Hiring|Support)(?![A-Za-z]))(${NAMEVAL})`, '', 2, '', ''],
  ['name_greeting', '[NAME]', String.raw`(?<![A-Za-z])((?:[Hh]i|[Hh]ello|[Hh]ey|[Hh]iya|[Gg]ood[ \t]+(?:morning|afternoon|evening))[ \t]+)(?!(?:Mr|Mrs|Ms|Mx|Miss|Dr|Prof|There|All|Team|Everyone|Folks|Guys|Again|Friend|Friends)(?![A-Za-z]))(${NAMEVAL})(?=[ \t]*[,!])`, '', 2, '', ''],
  ['name_title', '[NAME]', String.raw`(?<![A-Za-z])((?:Mr|Mrs|Ms|Mx|Miss|Dr|Prof)\.?[ \t]+)(${NAMEVAL})`, '', 2, '', ''],
  ['name_signoff', '[NAME]', String.raw`(?<![A-Za-z])((?:(?:[Kk]ind|[Bb]est|[Ww]arm|[Mm]any)[ \t]+)?(?:[Rr]egards|[Ww]ishes|[Tt]hanks)|[Ss]incerely|[Tt]hank[ \t]+you|[Cc]heers|[Bb]est|[Yy]ours(?:[ \t]+(?:truly|sincerely|faithfully))?)(,?[ \t]*\r?\n[ \t]*)(${NAMEVAL})(?=[ \t]*(?:[\r\n]|(?![\s\S])))`, '', 3, '', ''],
];

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------
const digitsOf = (v: string) => v.replace(/[^0-9]/g, '');

function luhn(v: string): boolean {
  const d = digitsOf(v);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

function iban(v: string): boolean {
  const s = v.replace(/ /g, '');
  if (s.length < 15 || s.length > 34) return false;
  const r = s.slice(4) + s.slice(0, 4);
  let mod = 0;
  for (const c of r) {
    const n = c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c;
    for (const x of n) mod = (mod * 10 + (x.charCodeAt(0) - 48)) % 97;
  }
  return mod === 1;
}

const CHECKS: Record<string, (v: string) => boolean> = {
  luhn,
  iban,
  phone: v => { const n = digitsOf(v).length; return n >= 9 && n <= 15; },
  account: v => { const n = digitsOf(v).length; return n >= 6 && n <= 17; },
  // A Bearer/Basic/Token value is a credential unless it is an ordinary word ("Basic membership").
  opaque: v => /[0-9+/=_.~\-]/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v) && !/^[A-Z][a-z]+$/.test(v)),
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
interface Rule { id: string; label: string; re: RegExp; group: number; need: string; check?: (v: string) => boolean }

const RULES: Rule[] = MASK_PATTERNS.map(([id, label, source, flags, group, need, check]) => ({
  id, label, group, need,
  re: new RegExp(source, `gd${flags}`),
  check: check ? CHECKS[check] : undefined,
}));

const bump = (counts: MaskCounts, label: string, n = 1) => { counts[label] = (counts[label] ?? 0) + n; };

function applyRule(s: string, rule: Rule, counts: MaskCounts): string {
  const re = rule.re;
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const span = rule.group ? m.indices?.[rule.group] : [m.index, m.index + m[0].length];
    if (!span || span[1] <= span[0]) continue;
    const [a, b] = span;
    if (rule.check && !rule.check(s.slice(a, b))) continue;
    out += s.slice(last, a) + rule.label;
    last = b;
    n++;
  }
  if (!n) return s;
  bump(counts, rule.label, n);
  return out + s.slice(last);
}

// ---- private values --------------------------------------------------------------------------------
interface PrivateRule { label: string; re: RegExp; probe: string }
const privateCache = new WeakMap<object, PrivateRule[]>();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/\-]/g, '\\$&');

/** Compile known personal values into exact-match rules, longest first. Invalid entries are ignored. */
export function compilePrivateValues(pv: PrivateValues | null | undefined): PrivateRule[] {
  if (!pv || typeof pv !== 'object') return [];
  const hit = privateCache.get(pv);
  if (hit) return hit;
  const items: { label: string; value: string }[] = [];
  for (const [rawLabel, values] of Object.entries(pv)) {
    const label = rawLabel.startsWith('[') ? rawLabel : `[${rawLabel}]`;
    if (!LABEL_ONLY.test(label) || !Array.isArray(values)) continue;
    for (const v of values) {
      if (typeof v !== 'string') continue;
      const value = v.trim().split(/[ \t\r\n ]+/).join(' ');
      if (value.length >= 3 && !LABEL_ONLY.test(value)) items.push({ label, value });
    }
  }
  items.sort((x, y) => y.value.length - x.value.length);
  const rules = items.map(({ label, value }) => ({
    label,
    probe: value.split(' ')[0]!.toLowerCase(),
    re: new RegExp(`(?<![A-Za-z0-9])${value.split(' ').map(escapeRe).join('[ \\t\\r\\n\\u00a0]+')}(?![A-Za-z0-9])`, 'gi'),
  }));
  privateCache.set(pv, rules);
  return rules;
}

function applyPrivate(s: string, rules: PrivateRule[], counts: MaskCounts): string {
  if (!rules.length) return s;
  let lower = s.toLowerCase();
  for (const r of rules) {
    if (!lower.includes(r.probe)) continue;
    let n = 0;
    const next = s.replace(r.re, () => { n++; return r.label; });
    if (n) { bump(counts, r.label, n); s = next; lower = s.toLowerCase(); }
  }
  return s;
}

function onePass(s: string, priv: PrivateRule[], counts: MaskCounts): string {
  s = applyPrivate(s, priv, counts);
  const hasDigit = /[0-9]/.test(s);
  for (const rule of RULES) {
    if (rule.need === 'D' ? !hasDigit : rule.need !== '' && !s.includes(rule.need)) continue;
    s = applyRule(s, rule, counts);
  }
  return s;
}

function maskString(s: string, priv: PrivateRule[], counts: MaskCounts): string {
  if (s.length < 3 || LABEL_ONLY.test(s)) return s;
  // Iterate to a fixed point (at most 3 passes) so the output is idempotent by construction.
  for (let i = 0; i < 3; i++) {
    const next = onePass(s, priv, counts);
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Mask one string. */
export function maskText(s: string, opts?: MaskOptions): { text: string; counts: MaskCounts } {
  const counts: MaskCounts = {};
  return { text: maskString(s, compilePrivateValues(opts?.privateValues), counts), counts };
}

// ---- object keys -----------------------------------------------------------------------------------
/** Key-based labelling tables, as plain data so the ports can embed the identical tables. */
export const MASK_KEY_TABLES = {
  SECRET_WORDS: [
    'password', 'passwords', 'passwd', 'pwd', 'passcode', 'passphrase', 'secret', 'secrets', 'token', 'auth',
    'authorization', 'cookie', 'cookies', 'session', 'sessionid', 'sid', 'credential', 'credentials', 'otp', 'totp',
    'cvv', 'cvv2', 'cvc', 'cvc2', 'pin', 'apikey', 'csrf', 'xsrf', 'jwt', 'bearer', 'sig', 'signature', 'privatekey',
    'accesskey', 'secretkey',
  ],
  SECRET_SUFFIXES: ['token', 'secret', 'password', 'passwd', 'apikey', 'cookie', 'credential', 'credentials', 'sessionid', 'privatekey'],
  SECRET_PAIR: String.raw`(^|_)(api|private|access|secret|signing|encryption)_key(_|$)`,
  EXEMPT_WORDS: ['count', 'total', 'limit', 'max', 'min', 'remaining', 'usage', 'used', 'type', 'kind', 'expires', 'expiry', 'ttl', 'length', 'len', 'required', 'present', 'valid', 'field', 'label', 'placeholder'],
  BOOL_PREFIX: ['is', 'has', 'use', 'enable', 'enabled', 'allow', 'show'],
  /** [regex source tested against the snake_cased key, label] in priority order. */
  KEY_LABELS: [
    [String.raw`(^|_)(ip|ipv4|ipv6|remote_addr|client_ip)(_|$)`, LABELS.IP],
    [String.raw`(^|_)(email|emails|e_mail|email_address|mail_address)(_|$)`, LABELS.EMAIL],
    [String.raw`(^|_)(card_?(number|num|no)|cc_?(number|num)|pan|credit_?card(_?number)?)(_|$)`, LABELS.CARD],
    [String.raw`(^|_)iban(_|$)`, LABELS.IBAN],
    [String.raw`(^|_)(account_?(number|num|no)|acct_?(number|num|no)|routing(_?number|_?no)?|sort_?code|bsb|bank_account)(_|$)`, LABELS.ACCOUNT],
    [String.raw`(^|_)(ssn|social_security(_number)?|national_insurance(_number)?|ni_number|nino|tax_id|taxpayer_id)(_|$)`, LABELS.SSN],
    [String.raw`(^|_)(dob|date_of_birth|birth_?date|birthday)(_|$)`, LABELS.DOB],
    [String.raw`(^|_)(post_?code|postal_?code|zip|zip_?code)(_|$)`, LABELS.POSTCODE],
    [String.raw`(^|_)(phone|phones|telephone|tel|mobile|cell|cellphone|fax|msisdn|whatsapp|phone_number)(_|$)`, LABELS.PHONE],
    [String.raw`(^|_)(address|addresses|addr|street|street_address|address_line_?[0-9]?|house_number)(_|$)`, LABELS.ADDRESS],
    [String.raw`(^|_)((full|first|last|given|family|middle|maiden|legal|customer|contact|guest|passenger|recipient|cardholder|holder|billing|shipping|traveller|traveler|sur)_?name|surname|name_on_card)(_|$)`, LABELS.NAME],
  ] as [string, string][],
  NOT_ADDRESS: ['ip', 'email', 'mac', 'web', 'url', 'wallet', 'contract', 'memory', 'hex'],
  URL_WORDS: ['url', 'urls', 'href', 'uri', 'link', 'src', 'referrer', 'referer'],
};
const SECRET_WORDS = new Set(MASK_KEY_TABLES.SECRET_WORDS);
const SECRET_SUFFIXES = MASK_KEY_TABLES.SECRET_SUFFIXES;
const SECRET_PAIR = new RegExp(MASK_KEY_TABLES.SECRET_PAIR);
const EXEMPT_WORDS = new Set(MASK_KEY_TABLES.EXEMPT_WORDS);
const BOOL_PREFIX = new Set(MASK_KEY_TABLES.BOOL_PREFIX);
const KEY_LABELS: [RegExp, string][] = MASK_KEY_TABLES.KEY_LABELS.map(([src, l]) => [new RegExp(src), l]);
const NOT_ADDRESS = new Set(MASK_KEY_TABLES.NOT_ADDRESS);
const URL_WORDS = new Set(MASK_KEY_TABLES.URL_WORDS);
const keyCache = new Map<string, string | null>();

/** Label implied by an object key ('[SECRET]', '[EMAIL]', ...), 'URL' for url-ish keys, or null. */
export function keyLabel(key: string): string | null {
  const cached = keyCache.get(key);
  if (cached !== undefined) return cached;
  const norm = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const words = norm.split('_').filter(Boolean);
  let label: string | null = null;
  if (words.length && !words.some(w => EXEMPT_WORDS.has(w)) && !BOOL_PREFIX.has(words[0]!)) {
    if (words.some(w => SECRET_WORDS.has(w) || SECRET_SUFFIXES.some(sfx => w.endsWith(sfx))) || SECRET_PAIR.test(norm)) {
      label = LABELS.SECRET;
    } else {
      for (const [re, l] of KEY_LABELS) {
        if (!re.test(norm)) continue;
        if (l === LABELS.ADDRESS && words.some(w => NOT_ADDRESS.has(w))) continue;
        label = l;
        break;
      }
      if (!label && URL_WORDS.has(words[words.length - 1]!)) label = 'URL';
    }
  }
  if (keyCache.size < 5000) keyCache.set(key, label);
  return label;
}

interface Ctx { priv: PrivateRule[]; counts: MaskCounts }

function walk(v: unknown, forced: string | null, urlish: boolean, ctx: Ctx): unknown {
  if (typeof v === 'string') {
    if (!v || LABEL_ONLY.test(v)) return v;
    if (forced) { bump(ctx.counts, forced); return forced; }
    if (urlish && /^([a-z][a-z0-9+.\-]*:\/\/|\/)/i.test(v.trim())) return urlPath(v, ctx);
    return maskString(v, ctx.priv, ctx.counts);
  }
  if (Array.isArray(v)) return v.map(x => walk(x, forced, urlish, ctx));
  if (v && typeof v === 'object') {
    // fromEntries defines own properties, so a "__proto__" key stays data instead of becoming the prototype.
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => {
      const l = forced ? null : keyLabel(k);
      return [k, walk(x, forced ?? (l && l !== 'URL' ? l : null), l === 'URL', ctx)];
    }));
  }
  return v;
}

/** Deep-mask any JSON value: every string value, plus values under secret-looking keys. Never mutates input. */
export function maskDeep<T>(value: T, opts?: MaskOptions): MaskResult<T> {
  const ctx: Ctx = { priv: compilePrivateValues(opts?.privateValues), counts: {} };
  const out = walk(value, null, false, ctx) as T;
  let total = 0;
  for (const n of Object.values(ctx.counts)) total += n;
  return { value: out, counts: ctx.counts, total };
}

// ---- URLs ------------------------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_SEG = /^[^@\/]+@[^@\/]+\.[A-Za-z]{2,}$/;

function tokenLike(seg: string): boolean {
  if (seg.length < 16 || !/^[A-Za-z0-9_\-.~+=%]+$/.test(seg) || !/[0-9]/.test(seg) || !/[A-Za-z]/.test(seg)) return false;
  // Slugs ("my-cool-product-2024") are words joined by '-'/'_'; tokens have a long unbroken run.
  return seg.split(/[\-_.]/).some(p => p.length >= 16);
}

function maskSegment(raw: string, ctx: Ctx): string {
  if (!raw || raw.startsWith(':') || LABEL_ONLY.test(raw)) return raw;
  let seg = raw;
  try { seg = decodeURIComponent(raw); } catch { /* keep raw */ }
  if (EMAIL_SEG.test(seg)) { bump(ctx.counts, LABELS.EMAIL); return LABELS.EMAIL; }
  if (UUID.test(seg) || /^[0-9]{6,}$/.test(seg)) return ':id';
  if (tokenLike(seg)) return ':token';
  const ids = seg.replace(/[0-9]{6,}/g, ':id');
  const masked = maskString(ids, ctx.priv, ctx.counts);
  return masked === seg ? raw : masked;
}

function urlPath(url: string, ctx: Ctx): string {
  const s = url.trim();
  const m = /^([a-z][a-z0-9+.\-]*:\/\/)([^\/?#]*)([^?#]*)/i.exec(s);
  if (m) {
    let host = m[2]!.replace(/^.*@/, '').toLowerCase();
    const bare = host.replace(/^\[|\](:[0-9]+)?$|:[0-9]+$/g, '');
    if (/^[0-9.]+$/.test(bare) || bare.includes(':')) { bump(ctx.counts, LABELS.IP); host = LABELS.IP; }
    return m[1]!.toLowerCase() + host + m[3]!.split('/').map(p => maskSegment(p, ctx)).join('/');
  }
  if (s.startsWith('/')) return s.split(/[?#]/)[0]!.split('/').map(p => maskSegment(p, ctx)).join('/');
  return maskString(s, ctx.priv, ctx.counts);
}

/** Strip query string + fragment (and URL credentials) and mask path segments that look like ids/emails/tokens. */
export function maskUrl(url: string, opts?: MaskOptions): string {
  return urlPath(url, { priv: compilePrivateValues(opts?.privateValues), counts: {} });
}
