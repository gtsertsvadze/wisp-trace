# Handoff: state of the v0.1 prototype

For a coding agent picking this up cold. Read [SPEC.md](SPEC.md) and [ARCHITECTURE.md](ARCHITECTURE.md) first; ARCHITECTURE.md is the contract (API shapes, product rules, module map) and is accurate to the code.

## Live

- Worker deployed: https://wisptrace.george-tsertsvadze97.workers.dev (D1 `wisptrace`, migrations 0001 and 0002 applied, crons registered).
- **wisptrace.com is not attached yet.** The zone has pre-existing DNS records (likely registrar parking). In the Cloudflare dashboard → wisptrace.com → DNS, delete the existing A/AAAA/CNAME records for `wisptrace.com` and `www`, then run `npx wrangler deploy` again; the custom-domain routes are already in `wrangler.jsonc`.
- Production secrets `ADMIN_TOKEN` and `HASH_SALT` are set. Their values are in `.secrets.local` (gitignored, on the original machine only).
- Production DB is empty by design (rule: never fake anything). Pages show honest empty states.

## Done and verified

| Area | Files | Verified by |
|---|---|---|
| Masking (PII labels, secrets stripped) | `src/lib/mask.ts` | `test/mask.test.ts` (8 tests), live ingest check: emails, cards, cookies, API keys, prose passwords masked before storage |
| Agent skill (Node + Python clients, byte-identical masking) | `public/skill.md`, `public/heartbeat.md`, `public/skill.json`, `public/skill/*` | parity test; real register → claim → send against a dev server with both clients |
| Agent API + ingest | `src/api/agents.ts`, `src/api/traces.ts`, `src/processing/ingest.ts`, `classify.ts`, `src/lib/auth.ts`, `normalize.ts`, `ratelimit.ts`, `http.ts` | curl: register, 403 before claim, 201 with masked storage, 400 on invalid, checkin, me |
| Raw trace store (R2 or gzipped D1) | `src/lib/rawstore.ts`, `migrations/0002_trace_raw.sql` | ingest → `trace_raw` row → owner API reads it back masked |
| Recipes, policies, trends, awards, cron | `src/processing/*`, `src/lib/sanitize.ts`, `src/api/recipes.ts` | `test/recipes.test.ts`; recipe API returns trusted recipe + notice; blocked site returns `recipes: []` + hand-back guidance; prod `run-jobs` OK |
| Image cards (SVG + PNG via resvg-wasm) | `src/cards/*`, `src/api/daily.ts` | all six card types render as PNG locally and in production |
| Pages (all 10) | `src/pages/*`, `src/data/*`, `public/css/*`, `public/js/*` | visual QA at 1440px against `docs/design/*.dc.html` and at 390px; empty-DB check in production |
| Claim flow + owner dashboard | `src/pages/claim.tsx`, `owner.tsx`, `src/api/claim.ts`, `owner.ts`, `src/lib/verify-post.ts` | dev-bypass claim; owner list, detail, delete |
| Admin API | `src/api/admin.ts` | prod: 401 without/with wrong token, dev routes 404 in production, `run-jobs` 200 |

`npx tsc --noEmit` is clean and `npx vitest run` passes (47 tests).

## Backend TODO (in priority order)

1. **Attach wisptrace.com** (see above). A human must delete the DNS records.
2. **Seed agents.** "Don't open empty": create seed agents in production and point real agents (OpenClaw, Hermes…) running the skill at them doing real tasks. Must be live by ~12 Nov so trends have two weeks of data before Black Friday (27 Nov).
   ```bash
   curl -X POST https://<host>/api/admin/seed-agents -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'content-type: application/json' -d '{"name":"seed-01","app":"OpenClaw","model":"claude-sonnet-4.5"}'
   ```
   The response contains the agent's API key; put it in the agent's `~/.config/wisptrace/credentials.json`.
3. **End-to-end simulator** `scripts/simulate.mjs` (+ `scripts/scenarios/*.mjs`). Not written. Spec:
   - Refuse any host except 127.0.0.1/localhost. Options `--url`, `--agents 24`, `--days 21`, `--per-day 120`, `--live`, `--admin-token dev-admin-token`.
   - Register agents through the real `POST /api/v1/agents/register`, create 2 seed agents via `/api/admin/seed-agents`, claim the rest via `/api/admin/dev/claim`.
   - ~12 scenarios on fictional domains (fitlane.com, tablehop.com, parcelly.co, skyfare.io, streamly.tv, cityparking.gov…): happy path, alternatives, dead ends, failures. cityparking.gov always ends `handed_back` + `blocked_by_site: true`. skyfare.io's flow changes 5 days ago (old path fails after; new path succeeds from 2 days ago) to exercise out-of-date → new version.
   - Put realistic PII and secrets in observations and model responses; mask with the exports of `public/skill/wisptrace.mjs` before sending, exactly like a real agent.
   - Recent traces via `POST /api/v1/traces`; history via `POST /api/admin/dev/backfill` with `occurred_at`. Finish with `POST /api/admin/run-jobs`. Print a summary.
4. **Smoke test** `scripts/smoke.mjs` (`npm run smoke` already points at it). One PASS/FAIL line per check against `--url`: every page 200; `/skill.md`; register → dev claim → trace 201 → `/api/public/live` items contain no site and no task text; recipes API notice; card PNG content type; owner link → list → delete; blocked site returns `recipes: []`.
5. **Real claim verification.** X (oEmbed + syndication fallback) and Bluesky (public AppView) verification is implemented but has only been exercised through the dev bypass. Test with a real post of each kind once the domain is live.
6. **Optional:** `ANTHROPIC_API_KEY` secret enables LLM task classification and recipe wording (`src/lib/llm.ts`); everything works without it.
7. **Optional:** enable R2 on the account and uncomment the `r2_buckets` binding in `wrangler.jsonc`; `rawstore.ts` switches automatically. Existing D1 rows stay readable only through D1, so migrate them or accept the split.

## Known gaps (none block launch)

- Masking is pattern-based. A bare name with no context cue ("Entered Mira Kovacs") is only masked if the agent lists it in `~/.config/wisptrace/private-values.json` (documented in skill.md). The server pass cannot catch it.
- `public/skill.json` holds sha256 hashes of the client scripts. After changing `src/lib/mask.ts`, run `WISPTRACE_SYNC_SKILL=1 npx vitest run test/mask.test.ts` to regenerate the client rule tables and hashes, or the test fails.
- Live feed: if more rows become visible between two 4-second polls than the page limit, the middle ones are skipped (fine for a live view).
- Trends: the 14-day volume panel always ends yesterday, even when `?week=` points to a past week (it is labelled "last 14 days").
- Rate limits live in D1 (`rate_limits` table): fine at prototype scale; move to the Workers rate-limit binding if traffic grows.
- Small visual nits: breadcrumb separator spacing is slightly tighter than the design; `EmptyState` drops `data-*` attributes (pages wrap it in a div).
- Fixture traces have no raw JSON, so the owner detail view falls back to normalized steps for them. Real ingested traces show everything.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
node scripts/devserver.mjs start --port 8787 --fresh --fixture   # demo data, local only
node scripts/devserver.mjs stop --port 8787
npx tsc --noEmit && npx vitest run
node scripts/shot.mjs http://127.0.0.1:8787/ screenshots/home.png --full   # screenshot with local Chrome/Edge
```

Fixture credentials: API key `wt_devQuietfox7ApiKey000000000000`, owner page `/owner/wto_devQuietfox7OwnerToken0000000000`, unclaimed claim page `/claim/ne7-test` (verify with post URL `dev://yourname`). Component gallery: `/_kit`.
