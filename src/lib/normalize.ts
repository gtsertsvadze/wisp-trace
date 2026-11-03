// Normalisation of free-form identifiers coming from agents: domains, model ids, app names, agent names.
// Everything here is pure and deterministic (except generateAgentName) so it can be unit-tested.

// Multi-label public suffixes we care about (a pragmatic subset of the Public Suffix List, incl. a few
// private hosting suffixes where every subdomain is a different owner).
const MULTI_SUFFIXES = new Set([
  // UK
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'police.uk',
  // Australia / NZ
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'geek.nz',
  // Asia
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'gr.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'org.hk', 'net.hk', 'gov.hk', 'edu.hk',
  'com.tw', 'org.tw', 'net.tw', 'gov.tw', 'edu.tw',
  'com.sg', 'org.sg', 'net.sg', 'gov.sg', 'edu.sg',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'firm.in', 'gen.in', 'ind.in',
  'co.id', 'or.id', 'go.id', 'ac.id', 'web.id',
  'co.th', 'in.th', 'or.th', 'go.th', 'ac.th',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph',
  'com.vn', 'net.vn', 'gov.vn', 'com.pk', 'net.pk', 'org.pk', 'gov.pk',
  'co.il', 'org.il', 'ac.il', 'gov.il', 'net.il',
  'com.sa', 'net.sa', 'gov.sa', 'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'gen.tr',
  'ae.org', 'co.ae', 'gov.ae',
  // Americas
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'art.br',
  'com.mx', 'org.mx', 'gob.mx', 'edu.mx', 'net.mx',
  'com.ar', 'gob.ar', 'org.ar', 'net.ar', 'com.co', 'gov.co', 'net.co', 'org.co',
  'com.pe', 'gob.pe', 'com.ec', 'com.uy', 'com.ve', 'com.bo', 'com.py', 'cl.cl',
  // Africa / Europe
  'co.za', 'org.za', 'gov.za', 'net.za', 'ac.za', 'com.ng', 'gov.ng', 'com.eg', 'co.ke', 'or.ke',
  'com.ua', 'org.ua', 'gov.ua', 'com.pl', 'net.pl', 'org.pl', 'co.at', 'or.at', 'gv.at',
  'com.es', 'org.es', 'nom.es', 'com.gr', 'com.pt', 'com.ru', 'com.cy', 'com.mt',
  // Hosting platforms (each subdomain is an independent site)
  'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev',
  'blogspot.com', 'myshopify.com', 'web.app', 'firebaseapp.com', 'azurewebsites.net', 'cloudfront.net',
  'appspot.com', 'fly.dev', 'onrender.com', 'wordpress.com', 'substack.com', 'squarespace.com', 'wixsite.com',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_TLDS = new Set(['localhost', 'local', 'internal', 'lan', 'home', 'test', 'invalid', 'example', 'onion', 'arpa', 'corp', 'intranet']);

/** 'https://www.shop.fitlane.co.uk/a?b' -> 'fitlane.co.uk'. Returns null when it isn't a public domain. */
export function registrableDomain(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost || typeof urlOrHost !== 'string') return null;
  const raw = urlOrHost.trim();
  if (!raw || raw.length > 2048 || /\s/.test(raw.split(/[/?#]/)[0])) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/\//, '')}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.+$/, '');
  if (!host || host.includes(':') || host.startsWith('[') || IPV4.test(host)) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2 || labels.some(l => l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return null;
  const tld = labels[labels.length - 1];
  if (LOCAL_TLDS.has(tld) || !/^([a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(tld)) return null;
  const last2 = labels.slice(-2).join('.');
  if (MULTI_SUFFIXES.has(last2)) return labels.length >= 3 ? labels.slice(-3).join('.') : null;
  return last2;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
const MODEL_VENDOR_DOT = /^(?:(?:us|eu|apac|global|jp|au)\.)?(?:anthropic|openai|google|meta|mistral|amazon|cohere|deepseek|qwen|xai|ai21)\./;

/** 'anthropic/claude-sonnet-4-5-20250929' -> 'claude-sonnet-4.5'. Always returns a non-empty [a-z0-9.-] string. */
export function normalizeModel(s: string | null | undefined): string {
  let m = String(s ?? '').trim().toLowerCase();
  if (!m) return 'unknown';
  m = m.split('/').filter(Boolean).pop() ?? '';            // openrouter/anthropic/x, models/gemini-x
  m = m.replace(MODEL_VENDOR_DOT, '');                       // bedrock: us.anthropic.claude-…
  m = m.replace(/[\s_]+/g, '-');
  m = m.replace(/@.*$/, '');                                 // vertex: claude-sonnet-4-5@20250929
  m = m.replace(/:.*$/, '');                                 // :free, -v1:0, :latest
  m = m.replace(/-v\d+$/, '');                               // bedrock -v1
  m = m.replace(/-latest$/, '');
  m = m.replace(/-20\d{2}-?\d{2}-?\d{2}$/, '');              // -20250929, -2025-08-07
  m = m.replace(/-(?:exp|preview)-?\d{2}-\d{2}$/, '');       // gemini …-preview-05-06, …-exp-03-25
  m = m.replace(/-(?:exp|preview)$/, '');
  if (/^(?:gpt|chatgpt)-/.test(m)) m = m.replace(/-(?:0[1-9]|1[0-2])\d{2}$/, ''); // gpt-4-0613
  if (/^claude/.test(m)) {
    // claude-sonnet-4-5 -> claude-sonnet-4.5, claude-3-5-sonnet -> claude-3.5-sonnet
    m = m.replace(/-(\d)-(\d)(?=-|$)/g, '-$1.$2');
    m = m.replace(/^claude(\d)/, 'claude-$1');
  }
  m = m.replace(/[^a-z0-9.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  m = m.slice(0, 40).replace(/[-.]+$/, '');
  return m || 'unknown';
}

// ---------------------------------------------------------------------------
// Agent apps
// ---------------------------------------------------------------------------
const KNOWN_APPS: Record<string, string> = {
  openclaw: 'OpenClaw', clawdbot: 'OpenClaw', moltbot: 'OpenClaw',
  hermes: 'Hermes', hermesagent: 'Hermes', noushermes: 'Hermes',
  browseruse: 'Browser Use', lume: 'Lume',
  claudecode: 'Claude Code', claude: 'Claude', claudeai: 'Claude', claudedesktop: 'Claude', claudeforchrome: 'Claude for Chrome',
  codex: 'Codex', codexcli: 'Codex', openaicodex: 'Codex',
  manus: 'Manus', operator: 'Operator', openaioperator: 'Operator', chatgptagent: 'ChatGPT Agent', chatgpt: 'ChatGPT',
  goose: 'Goose', cline: 'Cline', cursor: 'Cursor', roocode: 'Roo Code', roo: 'Roo Code', kilocode: 'Kilo Code',
  windsurf: 'Windsurf', aider: 'Aider', openhands: 'OpenHands', devin: 'Devin', geminicli: 'Gemini CLI',
  computeruse: 'Computer Use', stagehand: 'Stagehand', skyvern: 'Skyvern', multion: 'MultiOn', comet: 'Comet',
  continue: 'Continue', zed: 'Zed', amp: 'Amp', opencode: 'OpenCode', n8n: 'n8n', langgraph: 'LangGraph',
  autogpt: 'AutoGPT', crewai: 'CrewAI', copilot: 'Copilot', githubcopilot: 'Copilot', perplexitycomet: 'Comet',
};

/** 'openclaw' -> 'OpenClaw', 'browser_use/0.7.1' -> 'Browser Use'. Unknown apps are title-cased, <= 24 chars. */
export function normalizeApp(s: string | null | undefined): string {
  let a = String(s ?? '').trim();
  if (!a) return 'Unknown';
  a = a.replace(/[\s/@]*v?\d+(?:\.\d+)+.*$/i, '').replace(/[\s/@]+v\d+$/i, ''); // strip versions
  const key = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key) return 'Unknown';
  const known = KNOWN_APPS[key];
  if (known) return known;
  const cleaned = a.replace(/[_]+/g, ' ').replace(/[^A-Za-z0-9 .-]+/g, '').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean).map(w =>
    w === w.toLowerCase() || (w === w.toUpperCase() && w.length > 3)
      ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      : w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(' ').slice(0, 24).trim() || 'Unknown';
}

// ---------------------------------------------------------------------------
// Agent names
// ---------------------------------------------------------------------------
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;

/** Exact names that can't be registered. */
export const RESERVED: readonly string[] = [
  'admin', 'administrator', 'official', 'anthropic', 'openai', 'google', 'claude', 'chatgpt', 'gemini', 'gpt',
  'wisp', 'wisptrace', 'root', 'system', 'support', 'staff', 'moderator', 'mod', 'team', 'security', 'abuse',
  'help', 'api', 'www', 'owner', 'null', 'undefined', 'unknown', 'anonymous', 'everyone', 'here', 'seed',
];
/** Name prefixes that can't be registered (seed agents and anything impersonating Wisptrace or a lab). */
export const RESERVED_PREFIXES: readonly string[] = ['seed', 'wisptrace', 'wisp-trace', 'admin', 'official', 'anthropic', 'openai'];

export function isReservedName(name: string): boolean {
  const n = name.toLowerCase();
  return RESERVED.includes(n) || RESERVED_PREFIXES.some(p => n.startsWith(p));
}

/** Sanitise a requested agent name to ^[a-z0-9][a-z0-9-]{2,31}$, or null. Does not check RESERVED (see isReservedName). */
export function normalizeAgentName(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null;
  const n = s.trim().toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return AGENT_NAME_RE.test(n) ? n : null;
}

const ADJECTIVES = [
  'quiet', 'tidal', 'brass', 'amber', 'swift', 'misty', 'lunar', 'solar', 'cedar', 'ember', 'frost', 'gentle',
  'hollow', 'ivory', 'jade', 'keen', 'lucky', 'mossy', 'noble', 'ochre', 'pale', 'rapid', 'silver', 'steady',
  'sunny', 'velvet', 'wild', 'witty', 'bold', 'calm', 'copper', 'dusky', 'fleet', 'golden', 'hazel', 'indigo',
  'lively', 'mellow', 'nimble', 'polar', 'rustic', 'sable', 'tawny', 'umber', 'vivid', 'woolly', 'zesty', 'clever',
];
const ANIMALS = [
  'fox', 'owl', 'heron', 'otter', 'lynx', 'wren', 'finch', 'badger', 'hare', 'moth', 'crane', 'raven', 'stoat',
  'marten', 'kestrel', 'falcon', 'gecko', 'ibis', 'koala', 'lemur', 'magpie', 'newt', 'orca', 'panda', 'quail',
  'robin', 'seal', 'tern', 'vole', 'walrus', 'yak', 'zebra', 'beetle', 'cobra', 'dingo', 'egret', 'ferret', 'gull',
  'hornet', 'jackal', 'kiwi', 'lark', 'mole', 'puffin', 'shrike', 'swift', 'toad', 'weasel',
];

function pick<T>(xs: readonly T[]): T {
  return xs[crypto.getRandomValues(new Uint32Array(1))[0] % xs.length];
}

/** Random friendly name: 'quietfox-7', 'tidal-owl', 'brass-heron-3'. Always matches AGENT_NAME_RE, never reserved. */
export function generateAgentName(): string {
  const adj = pick(ADJECTIVES);
  let animal = pick(ANIMALS);
  if (animal === adj) animal = 'fox';
  const digit = pick('23456789'.split(''));
  switch (pick([0, 1, 2])) {
    case 0: return `${adj}${animal}-${digit}`;
    case 1: return `${adj}-${animal}`;
    default: return `${adj}-${animal}-${digit}`;
  }
}
