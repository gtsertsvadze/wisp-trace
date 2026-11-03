// Specific task names. Every trace is named by a specific task, e.g. "Cancel Netflix subscription": the agent's own
// tag (TraceV1 task.tag) when it sends one, else a name extracted from the masked task description. Pure and
// deterministic (no I/O): src/processing/tasks.ts does the storage.
//
// Identity: two traces are the same task when their canonical keys match: '<canonical verb>|<sorted content words>'.
// "Cancel my Netflix subscription", "cancelled netflix plan" and "Unsubscribe from Netflix membership" all become
// 'cancel|netflix subscription'.
//
// Privacy: a name is built only from words of the (already masked) text, with mask labels, digits, emails, dates,
// times and pronouns removed. Public pages show it only once enough different humans share the same key
// (RULES.TASK_PUBLIC_MIN_CROWD), so one person's details can never become a public name.

export interface TaskName {
  key: string;      // 'cancel|netflix subscription'
  label: string;    // 'Cancel Netflix subscription'
  done: string;     // 'Cancelled Netflix subscription'
  verb: string;     // canonical verb, '' when none was found
  words: string[];  // sorted canonical content words (brand included when the name mentions it)
  brand: string;    // brand word from the site ('' without a site)
  sensitive: boolean;
  sensitiveKind: string | null;  // 'health', 'legal', ... (see SENSITIVE_WORDS)
}

// ---------------------------------------------------------------------------
// Verbs. Row: canonical, base (as shown), past, ...other forms that mean the same base.
// ---------------------------------------------------------------------------
const VERB_ROWS: string[][] = [
  ['cancel', 'cancel', 'cancelled', 'cancels', 'canceled', 'cancelling', 'canceling', 'cancellation'],
  ['cancel', 'unsubscribe from', 'unsubscribed from', 'unsubscribes from', 'unsubscribing from'],
  ['cancel', 'unsubscribe', 'unsubscribed', 'unsubscribes', 'unsubscribing'],
  ['cancel', 'terminate', 'terminated', 'terminates', 'terminating'],
  ['cancel', 'end', 'ended', 'ends', 'ending'],
  ['pause', 'pause', 'paused', 'pauses', 'pausing'],
  ['pause', 'freeze', 'froze', 'freezes', 'freezing', 'frozen'],
  ['pause', 'suspend', 'suspended', 'suspends', 'suspending'],
  ['resume', 'resume', 'resumed', 'resumes', 'resuming'],
  ['book', 'book', 'booked', 'books', 'booking'],
  ['book', 'reserve', 'reserved', 'reserves', 'reserving'],
  ['reschedule', 'reschedule', 'rescheduled', 'reschedules', 'rescheduling'],
  ['reschedule', 'rebook', 'rebooked', 'rebooks', 'rebooking'],
  ['change', 'change', 'changed', 'changes', 'changing'],
  ['change', 'modify', 'modified', 'modifies', 'modifying'],
  ['change', 'move', 'moved', 'moves', 'moving'],
  ['extend', 'extend', 'extended', 'extends', 'extending'],
  ['upgrade', 'upgrade', 'upgraded', 'upgrades', 'upgrading'],
  ['downgrade', 'downgrade', 'downgraded', 'downgrades', 'downgrading'],
  ['update', 'update', 'updated', 'updates', 'updating'],
  ['update', 'edit', 'edited', 'edits', 'editing'],
  ['buy', 'buy', 'bought', 'buys', 'buying'],
  ['buy', 'purchase', 'purchased', 'purchases', 'purchasing'],
  ['order', 'order', 'ordered', 'orders', 'ordering'],
  ['order', 'reorder', 'reordered', 'reorders', 'reordering'],
  ['shop', 'shop for', 'shopped for', 'shops for', 'shopping for'],
  ['return', 'return', 'returned', 'returns', 'returning'],
  ['request', 'request', 'requested', 'requests', 'requesting'],
  ['claim', 'claim', 'claimed', 'claims', 'claiming'],
  ['dispute', 'dispute', 'disputed', 'disputes', 'disputing'],
  ['track', 'track', 'tracked', 'tracks', 'tracking'],
  ['compare', 'compare', 'compared', 'compares', 'comparing'],
  ['find', 'find', 'found', 'finds', 'finding'],
  ['find', 'search for', 'searched for', 'searches for', 'searching for'],
  ['find', 'search', 'searched', 'searches', 'searching'],
  ['find', 'look for', 'looked for', 'looks for', 'looking for'],
  ['find', 'locate', 'located', 'locates', 'locating'],
  ['check in', 'check in', 'checked in', 'checks in', 'checking in'],
  ['check in', 'check-in', 'checked-in'],
  ['check out', 'check out', 'checked out', 'checks out', 'checking out'],
  ['check', 'check', 'checked', 'checks', 'checking'],
  ['pay', 'pay', 'paid', 'pays', 'paying'],
  ['pay', 'settle', 'settled', 'settles', 'settling'],
  ['renew', 'renew', 'renewed', 'renews', 'renewing', 'renewal'],
  ['switch', 'switch', 'switched', 'switches', 'switching'],
  ['apply', 'apply for', 'applied for', 'applies for', 'applying for'],
  ['apply', 'apply', 'applied', 'applies', 'applying'],
  ['sign up', 'sign up for', 'signed up for', 'signs up for', 'signing up for'],
  ['sign up', 'sign up', 'signed up', 'signs up', 'signing up'],
  ['sign up', 'register for', 'registered for', 'registers for', 'registering for'],
  ['sign up', 'register', 'registered', 'registers', 'registering'],
  ['sign up', 'enrol in', 'enrolled in', 'enroll in', 'enrolling in'],
  ['subscribe', 'subscribe to', 'subscribed to', 'subscribes to', 'subscribing to'],
  ['subscribe', 'subscribe', 'subscribed', 'subscribes', 'subscribing'],
  ['sign in', 'sign in to', 'signed in to', 'signing in to'],
  ['sign in', 'sign in', 'signed in', 'signs in', 'signing in'],
  ['sign in', 'log in to', 'logged in to', 'logging in to'],
  ['sign in', 'log in', 'logged in', 'logs in', 'logging in', 'login'],
  ['reset', 'reset', 'reset', 'resets', 'resetting'],
  ['recover', 'recover', 'recovered', 'recovers', 'recovering'],
  ['contact', 'contact', 'contacted', 'contacts', 'contacting'],
  ['call', 'call', 'called', 'calls', 'calling'],
  ['message', 'message', 'messaged', 'messages', 'messaging'],
  ['email', 'email', 'emailed', 'emails', 'emailing'],
  ['text', 'text', 'texted', 'texts', 'texting'],
  ['ask', 'ask', 'asked', 'asks', 'asking'],
  ['summarise', 'summarise', 'summarised', 'summarises', 'summarising', 'summarize', 'summarized', 'summarizes', 'summarizing'],
  ['research', 'research', 'researched', 'researches', 'researching'],
  ['schedule', 'schedule', 'scheduled', 'schedules', 'scheduling'],
  ['schedule', 'arrange', 'arranged', 'arranges', 'arranging'],
  ['set up', 'set up', 'set up', 'sets up', 'setting up'],
  ['submit', 'submit', 'submitted', 'submits', 'submitting'],
  ['submit', 'file', 'filed', 'files', 'filing'],
  ['fill in', 'fill in', 'filled in', 'fills in', 'filling in'],
  ['fill in', 'fill out', 'filled out', 'fills out', 'filling out'],
  ['send', 'send', 'sent', 'sends', 'sending'],
  ['download', 'download', 'downloaded', 'downloads', 'downloading'],
  ['upload', 'upload', 'uploaded', 'uploads', 'uploading'],
  ['create', 'create', 'created', 'creates', 'creating'],
  ['create', 'make', 'made', 'makes', 'making'],
  ['delete', 'delete', 'deleted', 'deletes', 'deleting'],
  ['delete', 'remove', 'removed', 'removes', 'removing'],
  ['add', 'add', 'added', 'adds', 'adding'],
  ['transfer', 'transfer', 'transferred', 'transfers', 'transferring'],
  ['top up', 'top up', 'topped up', 'tops up', 'topping up'],
  ['rent', 'rent', 'rented', 'rents', 'renting'],
  ['sell', 'sell', 'sold', 'sells', 'selling'],
  ['list', 'list', 'listed', 'lists', 'listing'],
  ['review', 'review', 'reviewed', 'reviews', 'reviewing'],
  ['fix', 'fix', 'fixed', 'fixes', 'fixing'],
  ['confirm', 'confirm', 'confirmed', 'confirms', 'confirming'],
  ['report', 'report', 'reported', 'reports', 'reporting'],
  ['get', 'get', 'got', 'gets', 'getting'],
  ['plan', 'plan', 'planned', 'plans', 'planning'],
  ['write', 'write', 'wrote', 'writes', 'writing', 'written'],
  ['write', 'draft', 'drafted', 'drafts', 'drafting'],
  ['reply', 'reply to', 'replied to', 'replies to', 'replying to'],
  ['reply', 'respond to', 'responded to', 'responds to', 'responding to'],
  ['open', 'open', 'opened', 'opens', 'opening'],
  ['close', 'close', 'closed', 'closes', 'closing'],
  ['install', 'install', 'installed', 'installs', 'installing'],
  ['redeem', 'redeem', 'redeemed', 'redeems', 'redeeming'],
  ['donate', 'donate to', 'donated to', 'donates to', 'donating to'],
  ['triage', 'triage', 'triaged', 'triages', 'triaging'],
  ['sort', 'sort', 'sorted', 'sorts', 'sorting'],
  ['organise', 'organise', 'organised', 'organises', 'organising', 'organize', 'organized', 'organizes', 'organizing'],
  ['translate', 'translate', 'translated', 'translates', 'translating'],
  ['print', 'print', 'printed', 'prints', 'printing'],
  ['use', 'use', 'used', 'uses', 'using'],
];

interface VerbForm { canonical: string; base: string; past: string; len: number }
const FORMS = new Map<string, VerbForm>();
const PAST_OF = new Map<string, string>();      // canonical -> past of its own base
for (const [canonical, base, past, ...rest] of VERB_ROWS) {
  for (const f of [base, past, ...rest]) {
    if (!FORMS.has(f)) FORMS.set(f, { canonical: canonical!, base: base!, past: past!, len: f.split(' ').length });
  }
  if (canonical === base) PAST_OF.set(canonical!, past!);
}

/** Verbs that carry their object: "Unsubscribe from Netflix" is the same task as "Cancel Netflix subscription". */
const IMPLIED: Record<string, string> = {
  unsubscribe: 'subscription', 'unsubscribe from': 'subscription',
};

/** "Cancelled something" for a task whose name is not public yet. */
const GENERIC_DONE: Record<string, string> = {
  'check in': 'Checked in', 'check out': 'Checked out', 'sign up': 'Signed up for something', 'sign in': 'Signed in somewhere',
  apply: 'Applied for something', subscribe: 'Subscribed to something', 'fill in': 'Filled in a form', 'top up': 'Topped up something',
  reply: 'Replied to something', donate: 'Donated to something', use: 'Used a website', 'set up': 'Set something up',
};

/** True when a name starts with its canonical verb ("Cancel ..." rather than "Unsubscribe from ..."). */
export function plainVerb(n: Pick<TaskName, 'verb' | 'label'>): boolean {
  return !!n.verb && n.label.toLowerCase().startsWith(`${n.verb} `);
}

/** "Cancel something" for a task that wasn't finished (failed or handed back) whose name is not public yet. */
const GENERIC_TRY: Record<string, string> = {
  'sign up': 'Sign up for something', 'sign in': 'Sign in somewhere', apply: 'Apply for something', subscribe: 'Subscribe to something',
  'fill in': 'Fill in a form', reply: 'Reply to something', donate: 'Donate to something', use: 'Use a website', 'set up': 'Set something up',
  'check in': 'Check in', 'check out': 'Check out',
};

export function genericTry(verb: string): string {
  if (!verb) return 'A task';
  return GENERIC_TRY[verb] ?? `${verb[0]!.toUpperCase()}${verb.slice(1)} something`;
}

export function genericDone(verb: string): string {
  if (!verb) return 'Did a task';
  if (GENERIC_DONE[verb]) return GENERIC_DONE[verb]!;
  const past = PAST_OF.get(verb) ?? `${verb}ed`;
  return `${past[0]!.toUpperCase()}${past.slice(1)} something`;
}

/** Verbs whose tasks count as shopping (the Black Friday watch on /trends). */
export const SHOPPING_VERBS = ['buy', 'order', 'shop'];

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------
const ARTICLES = new Set(['a', 'an', 'the', 'some', 'any']);
const PRONOUNS = new Set(['my', 'our', 'your', 'his', 'her', 'their', 'its', 'me', 'us', 'them', 'him', 'myself', 'ourselves', 'mine', 'yours']);
const PREPS = new Set(['to', 'for', 'of', 'on', 'at', 'in', 'into', 'onto', 'from', 'with', 'by', 'via', 'near', 'under', 'over',
  'around', 'about', 'within', 'without', 'through', 'per', 'off', 'up', 'out', 'as']);
const FILLER = new Set(['please', 'kindly', 'can', 'could', 'would', 'will', 'you', 'i', 'we', 'need', 'needs', 'want', 'wants', 'like',
  "i'd", "i'm", "we'd", "let's", 'just', 'quickly', 'help', 'go', 'ahead', 'try', 'it', 'hey', 'hi', 'and', 'then', 'also', 'now', 'asap',
  'urgently', 'again', 'still', 'should', 'must', 'do', 'is', 'be', 'that', 'this', 'these', 'those', 'online', 'so']);
// A description's name ends at the first of these once it has a content word.
const STRONG_BOUNDARY = new Set(['before', 'after', 'until', 'till', 'because', 'since', 'when', 'whenever', 'if', 'unless', 'while',
  'so', 'but', 'then', 'which', 'who', 'where', 'whose', 'that', 'and', 'or', 'also', 'plus', 'once', 'as', 'than', 'instead']);
const TIME = new Set(['today', 'tonight', 'tomorrow', 'yesterday', 'morning', 'afternoon', 'evening', 'night', 'noon', 'midnight',
  'week', 'weekend', 'weekday', 'month', 'year', 'day', 'days', 'weeks', 'months', 'hour', 'hours', 'minute', 'minutes', 'am', 'pm', 'asap',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs',
  'fri', 'sat', 'sun', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'next', 'last',
  'this', 'every', 'daily', 'weekly', 'monthly', 'annually', 'yearly', 'soon', 'later', 'early', 'late', 'usual']);
const NUMBER_WORDS = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'twenty', 'thirty', 'forty', 'fifty', 'hundred', 'thousand', 'first', 'second', 'third', 'couple', 'pair', 'few', 'several']);
// Same thing, different word (only where the meaning really is the same for a task).
const SYNONYMS: Record<string, string> = {
  membership: 'subscription', plan: 'subscription', reservation: 'booking', package: 'parcel', appt: 'appointment',
  tix: 'ticket', groceries: 'grocery', supermarket: 'grocery', taxi: 'ride', cab: 'ride', login: 'account', e: '',
};

// Sensitive topics, conservatively: a task touching any of these never appears by name next to a handle, and in trends
// only at category level. Agents can also mark a task sensitive (task.sensitive) and owners can, from the owner link.
const SENSITIVE_WORDS: Record<string, string[]> = {
  health: ['doctor', 'gp', 'clinic', 'hospital', 'dentist', 'dental', 'pharmacy', 'chemist', 'prescription', 'medication', 'medicine',
    'pill', 'therapy', 'therapist', 'counselling', 'counseling', 'counsellor', 'psychiatrist', 'psychologist', 'mental', 'anxiety',
    'depression', 'adhd', 'autism', 'std', 'sti', 'hiv', 'prep', 'abortion', 'contraception', 'contraceptive', 'condom', 'pregnancy',
    'fertility', 'ivf', 'rehab', 'addiction', 'diagnosis', 'symptom', 'vaccine', 'vaccination', 'mri', 'xray',
    'cancer', 'oncology', 'chemo', 'diabetes', 'insulin', 'ozempic', 'wegovy', 'surgery', 'gynaecologist', 'gynecologist',
    'urologist', 'dermatologist', 'nhs', 'medical', 'health', 'sick', 'disability'],
  legal: ['lawyer', 'solicitor', 'attorney', 'court', 'divorce', 'custody', 'bail', 'eviction', 'immigration', 'asylum', 'visa',
    'police', 'probation', 'prison', 'jail', 'arrest', 'lawsuit', 'tribunal', 'restraining'],
  money: ['debt', 'loan', 'payday', 'bankruptcy', 'overdraft', 'arrears', 'benefit', 'welfare', 'foodbank', 'unemployment',
    'pawn', 'bailiff', 'repossession', 'insolvency'],
  dating: ['dating', 'tinder', 'hinge', 'bumble', 'grindr', 'okcupid', 'adult', 'escort', 'sex', 'lgbt', 'lgbtq'],
  beliefs: ['church', 'mosque', 'synagogue', 'temple', 'prayer', 'religious'],
  gambling: ['bet', 'betting', 'casino', 'poker', 'gambling', 'lottery', 'bookmaker'],
  loss: ['funeral', 'condolence', 'bereavement', 'obituary', 'grave', 'cremation', 'probate'],
};
const SENSITIVE = new Map(Object.entries(SENSITIVE_WORDS).flatMap(([kind, ws]) => ws.map(w => [w, kind] as const)));

/** The sensitive category of a set of canonical words, or null. */
export function sensitiveKind(words: string[]): string | null {
  for (const w of words) { const k = SENSITIVE.get(w); if (k) return k; }
  return null;
}

/** Trends show sensitive tasks only by category. */
export const SENSITIVE_LABEL: Record<string, string> = {
  health: 'Health & medical tasks', legal: 'Legal tasks', money: 'Debt & benefits tasks', dating: 'Dating tasks',
  beliefs: 'Faith tasks', gambling: 'Betting tasks', loss: 'Bereavement tasks', other: 'Private tasks',
};

function singular(w: string): string {
  if (w.length <= 3 || /(ss|us|is|ous)$/.test(w)) return w;
  if (/ies$/.test(w) && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Canonical form of one content word, or '' when it carries no meaning for task identity. */
function canonWord(w: string): string {
  const s = singular(w.toLowerCase());
  const syn = SYNONYMS[s];
  return syn === undefined ? s : syn;
}

/** Stands where a personal detail (number, date, mask label, email) was removed: a name ends there. */
const GAP = '¶';

/** Tokens of masked text with everything that could be personal removed. Keeps the original casing. */
function tokens(text: string): string[] {
  const s = text
    .normalize('NFKC')
    .replace(/\[[A-Z][A-Z0-9_]*\]/g, ` ${GAP} `)               // [EMAIL], [NAME]... mask labels
    .replace(/\S+@\S+/g, ` ${GAP} `)                           // anything email-like
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/(?:www\.)?([a-z0-9-]+)[^\s]*/gi, ' $1 ') // url -> its first host label
    .replace(/\bwww\.([a-z0-9-]+)\S*/gi, ' $1 ')
    .replace(/\b([a-z0-9-]+)\.(?:co\.uk|com\.au|co|com|net|org|io|tv|app|fm|shop|store|gov|uk|de|fr|es|it|nl|eu|us|ca|au|ai|me)\b\S*/gi, ' $1 ')
    .replace(/[’`]/g, "'")
    .replace(/'s\b/gi, '')                                     // possessive
    // Anything with a digit goes (dates, times, amounts, party sizes, order numbers), except short model names: PS5, S24.
    .replace(/[A-Za-z0-9:/.,'-]*\d[A-Za-z0-9:/.,'-]*/g, m => {
      const t = m.replace(/[.,:'-]+$/, '');
      return /^[A-Za-z]{1,8}\d{1,4}[A-Za-z]?$/.test(t) ? ` ${t} ` : ` ${GAP} `;
    })
    .replace(/[^A-Za-z0-9À-ɏ'&¶ -]+/g, ' ')          // punctuation (except & ' -)
    .replace(/(^|\s)['&-]+|['&-]+(?=\s|$)/g, ' ');
  return s.split(/\s+/).filter(t => t === GAP || (t && /[A-Za-zÀ-ɏ]/.test(t) && t.length <= 30));
}

const isDropped = (t: string) => {
  const l = t.toLowerCase();
  return PRONOUNS.has(l) || TIME.has(l) || NUMBER_WORDS.has(l);
};

/** Longest verb form starting at tokens[i] (1-3 tokens). */
function verbAt(toks: string[], i: number): VerbForm | null {
  for (const n of [3, 2, 1]) {
    if (i + n > toks.length) continue;
    const f = FORMS.get(toks.slice(i, i + n).join(' ').toLowerCase());
    if (f && f.len === n) return f;
  }
  return null;
}

const isContent = (t: string) => {
  const l = t.toLowerCase();
  return t !== GAP && !ARTICLES.has(l) && !PREPS.has(l) && !FILLER.has(l) && !STRONG_BOUNDARY.has(l) && !isDropped(l);
};

/** Words after the verb, up to the first removed detail once the object has a word; dangling words tidied. */
function tidy(restIn: string[]): string[] {
  const gap = restIn.findIndex((t, i) => t === GAP && restIn.slice(0, i).some(isContent));
  const rest = (gap >= 0 ? restIn.slice(0, gap) : restIn).filter(t => t !== GAP);
  const kept = rest.filter(t => !isDropped(t) && !FILLER.has(t.toLowerCase()));
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const l = kept[i]!.toLowerCase();
    const next = kept[i + 1]?.toLowerCase();
    if ((PREPS.has(l) || ARTICLES.has(l)) && (next === undefined || PREPS.has(next))) continue; // "for on", trailing "at"
    if (ARTICLES.has(l) && next !== undefined && ARTICLES.has(next)) continue;
    out.push(kept[i]!);
  }
  while (out.length && (PREPS.has(out[out.length - 1]!.toLowerCase()) || ARTICLES.has(out[out.length - 1]!.toLowerCase()))) out.pop();
  return out;
}

export const brandDisplay = (brand: string) => (brand ? `${brand[0]!.toUpperCase()}${brand.slice(1)}` : '');

/** 'netflix.com' -> 'netflix', 'bbc.co.uk' -> 'bbc'. Expects a registrable domain. */
export function brandOfSite(site: string | null | undefined): string {
  if (!site) return '';
  const first = site.toLowerCase().split('.')[0] ?? '';
  return /^[a-z0-9-]{2,40}$/.test(first) ? first.replace(/-/g, '') : '';
}

interface Draft { verb: VerbForm | null; rest: string[] }

/** An agent's tag: the whole tag is the name (prepositions kept: "Return an item to Amazon"). */
function draftFromTag(tag: string): Draft | null {
  const toks = tokens(tag).slice(0, 16);
  let i = 0;
  while (i < toks.length && !verbAt(toks, i) && !isContent(toks[i]!)) i++; // skip "Please", "I need to"...
  if (i >= toks.length) return null;
  const v = verbAt(toks, i);
  const rest = tidy(toks.slice(v ? i + v.len : i));
  return rest.some(isContent) || v ? { verb: v, rest } : null;
}

/** A free-text description: the first verb in its opening words, then its object, cut at the first clause boundary. */
function draftFromDescription(text: string): Draft | null {
  const toks = tokens(text).slice(0, 40);
  let start = -1;
  let v: VerbForm | null = null;
  for (let i = 0; i < Math.min(10, toks.length); i++) {
    const f = verbAt(toks, i);
    if (f) { start = i; v = f; break; }
  }
  if (!v) return null;
  const rest: string[] = [];
  let content = 0;
  for (let i = start + v.len; i < toks.length; i++) {
    const t = toks[i]!;
    const l = t.toLowerCase();
    if (content === 0) {
      const f = verbAt(toks, i); // "find and book a table": the later verb is the task
      if (f && f.canonical !== v.canonical) { v = f; i += f.len - 1; rest.length = 0; continue; }
    }
    if (content > 0 && (STRONG_BOUNDARY.has(l) || (PREPS.has(l) && l !== 'of' && l !== 'up' && l !== 'out'))) break;
    if (isContent(t)) {
      if (content >= 3) break;
      content++;
    }
    rest.push(t);
  }
  return { verb: v, rest: tidy(rest) };
}

function capitalise(s: string): string {
  return s ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s;
}

/** Turns a draft into a full TaskName; `site` adds its brand when the name does not already name a service. */
function finish(d: Draft, site: string | null | undefined): TaskName | null {
  const brand = brandOfSite(site);
  let rest = d.rest.slice(0, 10);
  const verbBase = d.verb?.base ?? '';
  const restLower = rest.map(t => t.toLowerCase());
  const namesService = rest.some((t, i) => i > 0 && /^[A-ZÀ-Þ]/.test(t) && isContent(t))
    || (rest.length > 0 && /^[A-ZÀ-Þ]/.test(rest[0]!) && !!verbBase && isContent(rest[0]!));
  let brandInName = !!brand && restLower.some(t => t.replace(/[^a-z0-9]/g, '') === brand);
  if (brand && !brandInName && !namesService) {
    rest = [...rest, 'on', brandDisplay(brand)];
    brandInName = true;
  }
  // Brand words keep their site casing ("netflix" -> "Netflix"); everything else keeps the agent's casing.
  rest = rest.map(t => (brand && t.toLowerCase() === brand && t === t.toLowerCase() ? brandDisplay(brand) : t));
  const implied = d.verb && IMPLIED[d.verb.base] ? [IMPLIED[d.verb.base]!] : [];
  const words = [...new Set([...rest.filter(isContent).map(canonWord), ...implied].filter(Boolean))].sort();
  if (!words.length && !d.verb) return null;
  const verb = d.verb?.canonical ?? '';
  const label = capitalise([verbBase, ...rest].filter(Boolean).join(' ')).slice(0, 80).trim();
  const done = d.verb ? capitalise([d.verb.past, ...rest].join(' ')).slice(0, 90).trim() : label;
  return {
    key: `${verb}|${words.join(' ')}`,
    label,
    done,
    verb,
    words,
    brand: brandInName ? brand : '',
    sensitive: !!sensitiveKind(words),
    sensitiveKind: sensitiveKind(words),
  };
}

/** Name from an agent's own tag ("Cancel Netflix subscription"), or null when the tag has nothing usable. */
export function nameFromTag(tag: string | null | undefined, site?: string | null): TaskName | null {
  if (!tag || typeof tag !== 'string') return null;
  const d = draftFromTag(tag.slice(0, 200));
  return d ? finish(d, site) : null;
}

/** Name extracted from a masked task description, or null when no verb was found. */
export function nameFromDescription(text: string | null | undefined, site?: string | null): TaskName | null {
  if (!text || typeof text !== 'string') return null;
  const d = draftFromDescription(text.slice(0, 2000));
  return d ? finish(d, site) : null;
}

/** Last resort when neither the tag nor the description gives a verb: "Use Netflix" / "Web task". */
export function fallbackName(site?: string | null): TaskName {
  const brand = brandOfSite(site);
  if (brand) {
    return { key: `use|${brand}`, label: `Use ${brandDisplay(brand)}`, done: `Used ${brandDisplay(brand)}`, verb: 'use', words: [brand], brand, sensitive: false, sensitiveKind: null };
  }
  return { key: '|web task', label: 'Web task', done: 'Did a web task', verb: '', words: ['task', 'web'], brand: '', sensitive: false, sensitiveKind: null };
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'task';
}

/**
 * How well a stored task matches a name (0-1). Same verb required (when both have one), same brand required (when
 * both have one); then word overlap (Jaccard). Used for recipe lookups and to merge near-identical names at ingest.
 */
export function similarity(a: Pick<TaskName, 'verb' | 'words' | 'brand'>, b: Pick<TaskName, 'verb' | 'words' | 'brand'>): number {
  if (a.verb && b.verb && a.verb !== b.verb) return 0;
  if (a.brand && b.brand && a.brand !== b.brand) return 0;
  const A = new Set(a.words), B = new Set(b.words);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Whether an existing task may absorb a new wording: same verb and brand, and the wording contains every word of the
 * task plus at most one more ("Cancel gym membership on Fitlane" joins "Cancel Fitlane membership"). Never the other
 * way round: a task never takes on a word only some of its people used, so every word of a public name was used by
 * every person counted toward it.
 */
export function absorbs(task: Pick<TaskName, 'verb' | 'words' | 'brand'>, name: Pick<TaskName, 'verb' | 'words' | 'brand'>): boolean {
  if (task.verb !== name.verb || task.brand !== name.brand) return false;
  if (!task.words.length || name.words.length - task.words.length > 1 || name.words.length < task.words.length) return false;
  const N = new Set(name.words);
  return task.words.every(w => N.has(w));
}

/** Third person for captions: 'Cancel Netflix subscription' -> 'cancels Netflix subscriptions'... kept simple. */
export function thirdPerson(label: string): string {
  const [verb = '', ...rest] = label.trim().split(/\s+/);
  const v = verb.toLowerCase();
  const s = /(s|x|z|ch|sh)$/.test(v) ? `${v}es` : /[^aeiou]y$/.test(v) ? `${v.slice(0, -1)}ies` : `${v}s`;
  return [s, ...rest].join(' ');
}
