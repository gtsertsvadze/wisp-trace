// Masking: coverage of every label, idempotence, no false positives on ordinary trace text, and parity with the
// open-source clients (public/skill/wisptrace.mjs + wisptrace.py embed MASK_PATTERNS / MASK_KEY_TABLES verbatim).
//
// After changing src/lib/mask.ts, regenerate the clients' tables and public/skill.json hashes with:
//   WISPTRACE_SYNC_SKILL=1 npx vitest run test/mask.test.ts
import { describe, expect, it } from 'vitest';
import { MASK_KEY_TABLES, MASK_PATTERNS, maskDeep, maskText, type MaskResult, type PrivateValues } from '../src/lib/mask';

// No @types/node in this project: Node built-ins are loaded untyped behind minimal local interfaces.
interface Fs { readFileSync(p: string, enc: 'utf8'): string; writeFileSync(p: string, d: string): void; mkdirSync(p: string, o: object): void; readFileSync(p: string): Uint8Array }
interface Client {
  MASK_PATTERNS: unknown; MASK_KEY_TABLES: unknown;
  maskDeep<T>(v: T, o?: { privateValues?: PrivateValues | null }): MaskResult<T>;
  maskText(s: string, o?: { privateValues?: PrivateValues | null }): { text: string; counts: Record<string, number> };
}
const load = (m: string): Promise<any> => import(/* @vite-ignore */ m); // eslint-disable-line @typescript-eslint/no-explicit-any
const proc = (globalThis as unknown as { process: { cwd(): string; env: Record<string, string | undefined> } }).process;
const fs: Fs = await load('node:fs');
const { createHash } = await load('node:crypto') as { createHash(a: string): { update(d: Uint8Array): { digest(e: 'hex'): string } } };
const { spawnSync } = await load('node:child_process') as { spawnSync(cmd: string, args: string[], o: object): { status: number | null; stdout: string; stderr: string; error?: Error } };
const { pathToFileURL } = await load('node:url') as { pathToFileURL(p: string): { href: string } };

const ROOT = proc.cwd().replace(/\\/g, '/');
const MJS = `${ROOT}/public/skill/wisptrace.mjs`;
const PY = `${ROOT}/public/skill/wisptrace.py`;
const SKILL_JSON = `${ROOT}/public/skill.json`;

// ---- generator: embed the tables in both clients ---------------------------------------------------
const BEGIN = 'BEGIN GENERATED MASK TABLES (from src/lib/mask.ts by test/mask.test.ts; do not edit by hand)';
const END = 'END GENERATED MASK TABLES';

function jsBlock(): string {
  const rules = MASK_PATTERNS.map(r => `  ${JSON.stringify(r)},`).join('\n');
  return `// ${BEGIN}\nexport const MASK_PATTERNS = [\n${rules}\n];\nexport const MASK_KEY_TABLES = ${JSON.stringify(MASK_KEY_TABLES, null, 2)};\n// ${END}`;
}
function pyBlock(): string {
  const rules = `[\n${MASK_PATTERNS.map(r => `  ${JSON.stringify(r)}`).join(',\n')}\n]`;
  const tables = JSON.stringify(MASK_KEY_TABLES, null, 2);
  if (rules.includes('"""') || tables.includes('"""')) throw new Error('table text cannot be embedded in a Python raw string');
  return `# ${BEGIN}\nMASK_PATTERNS = json.loads(r"""${rules}""")\nMASK_KEY_TABLES = json.loads(r"""${tables}""")\n# ${END}`;
}
function replaceBlock(text: string, block: string, comment: string): string {
  const a = text.indexOf(`${comment} ${BEGIN}`);
  const b = text.indexOf(`${comment} ${END}`);
  if (a < 0 || b < a) throw new Error('generated block markers not found');
  return text.slice(0, a) + block + text.slice(b + `${comment} ${END}`.length);
}
const sha256 = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

if (proc.env.WISPTRACE_SYNC_SKILL) {
  fs.writeFileSync(MJS, replaceBlock(fs.readFileSync(MJS, 'utf8'), jsBlock(), '//'));
  fs.writeFileSync(PY, replaceBlock(fs.readFileSync(PY, 'utf8'), pyBlock(), '#'));
  const manifest = JSON.parse(fs.readFileSync(SKILL_JSON, 'utf8'));
  manifest.sha256 = { 'skill/wisptrace.mjs': sha256(MJS), 'skill/wisptrace.py': sha256(PY) };
  fs.writeFileSync(SKILL_JSON, `${JSON.stringify(manifest, null, 2)}\n`);
}

const client: Client = await load(pathToFileURL(MJS).href);

// ---- fixtures --------------------------------------------------------------------------------------
const PRIVATE: PrivateValues = { '[NAME]': ['Mira Kovacs'], ADDRESS: ['Flat 3, Larch House'] };

const SECRETS = {
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx4\n-----END RSA PRIVATE KEY-----',
  anthropic: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  github: 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  bearer: 'Zm9vYmFyYmF6cXV4MTIz',
  cookie: 'sessionid=8f2a9c1e77b04d1a',
  urlpass: 'hunter2pass',
  kv: 'S3cr3t!pw',
  prose: 'hunter22',
};

const TRACE = {
  schema: 'wisptrace.trace/v1',
  task: { description: 'Book a table for Mira Kovacs at Flat 3, Larch House', sites: ['bistroverde.co.uk'] },
  steps: [
    { action: 'Typed email', target: 'Email', observation: 'Entered mira.kovacs@example.com' },
    { action: 'Typed phone', observation: 'Phone: +44 7700 900123, landline 020 7946 0958, call me on (415) 555-0132' },
    { action: 'Paid', observation: 'Card 4111 1111 1111 1111, CVV: 123, exp 12/29', sensitive: 'payment' },
    { action: 'Bank', observation: 'IBAN GB82 WEST 1234 5698 7654 32, account number 31926819, sort code 12-34-56' },
    { action: 'Identity', observation: 'SSN 123-45-6789, NI number AB 12 34 56 C, date of birth: 14/03/1987' },
    { action: 'Address', observation: 'Ship to 221B Baker Street, London NW1 6XE; US office 500 Market St, San Francisco, CA 94105' },
    { action: 'Names', observation: 'My name is Tomas Novak. Dear Anna, thanks. Name: Lena Fischer' },
    { action: 'Network', observation: 'Client IP 203.0.113.42 and 2001:db8:85a3::8a2e:370:7334' },
    { action: 'Login', observation: `password: ${SECRETS.kv}. Entered email x and password ${SECRETS.prose}. Your verification code is 482913` },
    { action: 'Keys', observation: `key ${SECRETS.anthropic}, aws ${SECRETS.aws}, gh ${SECRETS.github}, jwt ${SECRETS.jwt}` },
    { action: 'Headers', observation: `Authorization: Bearer ${SECRETS.bearer}\nCookie: ${SECRETS.cookie}` },
    { action: 'Proxy', observation: `Used ftp://admin:${SECRETS.urlpass}@files.example.com/x and ${SECRETS.pem}` },
    { action: 'Opened link', url: 'https://www.bistroverde.co.uk/account/mira.kovacs@example.com/orders/88412345?token=abc123' },
  ],
  form: { password: 'whatever-it-is', api_key: 'zzz', email: 'someone@example.org', card_number: '5555555555554444', zip: '90210', first_name: 'Ola' },
  outcome: { status: 'done' },
};

const RAW_VALUES = [
  'Mira Kovacs', 'Larch House', 'mira.kovacs', '7700 900123', '7946 0958', '555-0132', '4111 1111', 'CVV: 123', 'GB82', '31926819', '12-34-56',
  '123-45-6789', 'AB 12 34 56 C', '14/03/1987', 'Baker Street', 'NW1 6XE', '94105', 'Tomas', 'Novak', 'Anna', 'Lena', 'Fischer',
  '203.0.113.42', '2001:db8', '482913', 'whatever-it-is', 'zzz', 'someone@', '5555555555554444', '90210', 'Ola', '88412345', 'abc123',
  ...Object.values(SECRETS),
];

const BENIGN = [
  "Opened https://shop.example.com/products/blue-widget-2024 and clicked 'Add to basket'.",
  'The page showed 3 items, total £42.50, delivery in 2-3 days, order 14 of 20.',
  'Password field is required. The password must be at least 8 characters. Clicked Forgot password.',
  'Selected size 10, quantity 2 and a table for 4 at 19:30 on 2026-11-07. Version 1.4.2 of the app.',
  'Basic membership costs £9.99 a month. Bearer of the card must be present. Token Ring adapter.',
  'Step 6 failed: the Continue button was disabled until the terms checkbox was ticked.',
];

describe('maskDeep', () => {
  const masked = maskDeep(TRACE, { privateValues: PRIVATE });
  const text = JSON.stringify(masked.value);

  it('masks every kind of personal value and secret', () => {
    for (const raw of RAW_VALUES) expect(text, raw).not.toContain(raw);
    for (const label of ['[EMAIL]', '[PHONE]', '[CARD]', '[IBAN]', '[ACCOUNT]', '[SSN]', '[DOB]', '[POSTCODE]', '[ADDRESS]', '[NAME]', '[IP]', '[SECRET]']) {
      expect(masked.counts[label] ?? 0, label).toBeGreaterThan(0);
    }
    // Structure and context words survive.
    expect(masked.value.steps).toHaveLength(TRACE.steps.length);
    expect(text).toContain('sort code [ACCOUNT]');
    expect(text).toContain('Authorization: [SECRET]');
    expect(masked.value.steps[12]!.url).toBe('https://www.bistroverde.co.uk/account/[EMAIL]/orders/:id');
  });

  it('is idempotent', () => {
    const again = maskDeep(masked.value, { privateValues: PRIVATE });
    expect(again.value).toEqual(masked.value);
    expect(again.total).toBe(0);
  });

  it('leaves ordinary trace text alone', () => {
    for (const s of BENIGN) expect(maskText(s).text).toBe(s);
  });
});

describe('client parity', () => {
  it('the Node client embeds the exact rule table', () => {
    expect(client.MASK_PATTERNS).toEqual(MASK_PATTERNS);
    expect(client.MASK_KEY_TABLES).toEqual(MASK_KEY_TABLES);
  });

  it('the Python client embeds the exact rule table', () => {
    const py = fs.readFileSync(PY, 'utf8');
    const grab = (name: string) => JSON.parse(new RegExp(`^${name} = json\\.loads\\(r"""([\\s\\S]*?)"""\\)$`, 'm').exec(py)![1]!);
    expect(grab('MASK_PATTERNS')).toEqual(MASK_PATTERNS);
    expect(grab('MASK_KEY_TABLES')).toEqual(MASK_KEY_TABLES);
  });

  it('the Node client masks the fixture identically', () => {
    const a = maskDeep(TRACE, { privateValues: PRIVATE });
    const b = client.maskDeep(TRACE, { privateValues: PRIVATE });
    expect(b.value).toEqual(a.value);
    expect(b.counts).toEqual(a.counts);
    for (const s of BENIGN) expect(client.maskText(s).text).toBe(s);
  });

  it('public/skill.json hashes match the scripts', () => {
    const manifest = JSON.parse(fs.readFileSync(SKILL_JSON, 'utf8'));
    expect(manifest.sha256['skill/wisptrace.mjs']).toBe(sha256(MJS));
    expect(manifest.sha256['skill/wisptrace.py']).toBe(sha256(PY));
  });

  const python = ['python3', 'python'].find(cmd => !spawnSync(cmd, ['--version'], { encoding: 'utf8' }).error
    && spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0);
  it.skipIf(!python)('the Python client masks the fixture identically', () => {
    const pyMask = spawnSync(python!, ['-I', '-c',
      `import sys, json; sys.path.insert(0, ${JSON.stringify(`${ROOT}/public/skill`)}); import wisptrace as w
r = w.mask_deep(json.loads(sys.stdin.buffer.read().decode("utf-8")), private_values=json.loads(${JSON.stringify(JSON.stringify(PRIVATE))}))
sys.stdout.write(json.dumps({"value": r["value"], "counts": r["counts"]}))`,
    ], { input: JSON.stringify(TRACE), encoding: 'utf8' });
    expect(pyMask.stderr).toBe('');
    const got = JSON.parse(pyMask.stdout);
    const want = maskDeep(TRACE, { privateValues: PRIVATE });
    expect(got.value).toEqual(want.value);
    expect(got.counts).toEqual(want.counts);
  });
});
