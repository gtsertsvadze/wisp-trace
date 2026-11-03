# Handoff: state of the prototype

For a coding agent picking this up cold. Read [SPEC.md](SPEC.md) (including its 2026-11-03 revision at the end) and [ARCHITECTURE.md](ARCHITECTURE.md) first; ARCHITECTURE.md is the contract (API shapes, product rules, module map) and is accurate to the code.

## The model in one paragraph

Every trace is named by a **specific task** ("Cancel Netflix subscription"): the agent's own `task.tag`, else the optional LLM, else a name extracted from the masked description (`src/lib/tasks.ts`). Different wordings share one canonical key, near-identical names merge (`src/processing/tasks.ts`). Recipes are built per (task, site) straight from the stored full traces (no step table), agents look them up by free text, and a trace that followed a recipe and succeeded upvotes the agents that built it. Trends and leaderboards are per task. A task's name is public only once 3 different people's agents have done it.

## Live

- https://wisptrace.com via Workers zone routes (`wisptrace.com/*`, `www.wisptrace.com/*`); www and http redirect to https://wisptrace.com. Also https://wisptrace.george-tsertsvadze97.workers.dev.
- D1 `wisptrace`, migrations 0001–0003 applied, crons registered. Production secrets `ADMIN_TOKEN` and `HASH_SALT` are set; values in `.secrets.local` (gitignored, original machine only).
- Production DB is empty by design (rule: never fake anything). Pages show honest empty states.

## Done and verified

| Area | Files | Verified by |
|---|---|---|
| Task naming (tag / description → specific task, canonical keys, merging, sensitive flag) | `src/lib/tasks.ts`, `src/processing/tasks.ts` | `test/ingest.test.ts` (wordings merge, details dropped, past tense, brand), local e2e |
| Crowd threshold (name public at 3 people; 2 agents of one owner count once) | `src/processing/tasks.ts` (`isNewToCrowd`, `recountTasks`) | local e2e |
| Masking (PII labels, secrets stripped) | `src/lib/mask.ts` | `test/mask.test.ts`, live ingest check |
| Agent skill (Node + Python clients) | `public/skill.md`, `public/skill/*`, `public/skill.json` | parity test; both clients' `recipes --task` against a dev server |
| Agent API + ingest | `src/api/agents.ts`, `src/api/traces.ts`, `src/processing/ingest.ts`, `src/processing/steps.ts` | curl + e2e: register, 403 before claim, 201 with `task`, upvote on followed recipe |
| Raw trace store (R2 or gzipped D1) | `src/lib/rawstore.ts` | recipes rebuilt from it; owner view reads it |
| Recipes per (task, site), lookup by free text, contributors, upvotes | `src/processing/recipes.ts`, `src/api/recipes.ts` | `test/recipes.test.ts`; e2e: "please cancel my netflix membership" finds "Cancel Netflix subscription" |
| Trends per task + trending flags; awards | `src/processing/trends.ts`, `awards.ts`, `cron.ts` | fixture run: movers, 6 awards |
| Pages (all 10) and cards | `src/pages/*`, `src/data/*`, `src/cards/*` | screenshots at 1440px with the fixture; e2e: every page and card 200 |
| Claim flow + owner dashboard | `src/pages/claim.tsx`, `owner.tsx`, `src/api/claim.ts`, `owner.ts` | dev-bypass claim; owner list, detail, delete (recounts crowd, removes upvotes) |
| Admin API | `src/api/admin.ts` | prod: 401 without/with wrong token, dev routes 404 in production |

`npx tsc --noEmit` is clean and `npx vitest run` passes (41 tests).

## Backend TODO (in priority order)

1. **Seed agents.** "Don't open empty": create seed agents in production and point real agents (OpenClaw, Hermes…) running the skill at them doing real tasks, with `task.tag` set. Must be live by ~12 Nov so trends have two weeks of data before Black Friday (27 Nov).
   ```bash
   curl -X POST https://wisptrace.com/api/admin/seed-agents -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'content-type: application/json' -d '{"name":"seed-01","app":"OpenClaw","model":"claude-sonnet-4.5"}'
   ```
   The response contains the agent's API key; put it in the agent's `~/.config/wisptrace/credentials.json`. Each seed agent counts as one person toward a task's crowd, so 3 seed agents doing the same task make its name public.
2. **Smoke test** `scripts/smoke.mjs` (`npm run smoke` points at it). Not written. One PASS/FAIL line per check against `--url`: every page 200; `/skill.md`; register → dev claim → trace 201 → `/api/public/live` has no task text; recipe lookup by free text; card PNG content type; owner link → list → delete; blocked site returns `recipes: []`. A local-only version of most of this lives in the session scratchpad as e2e.mjs; the fixture (below) also exercises the whole pipeline.
3. **Real claim verification.** X (oEmbed + syndication fallback) and Bluesky (public AppView) verification is implemented but only exercised through the dev bypass. Test with a real post of each kind.
4. **Optional:** `ANTHROPIC_API_KEY` secret: Claude names untagged traces (reusing existing names on the same site) and polishes recipe wording (`src/lib/llm.ts`). Everything works without it.
5. **Optional:** enable R2 and uncomment the `r2_buckets` binding in `wrangler.jsonc`; `rawstore.ts` switches automatically (existing D1 rows stay readable only through D1).

## Known gaps (none block launch)

- **Naming is heuristic.** Untagged descriptions can fragment ("Return the jacket on Parcelly" vs "Return an item on Parcelly"). Tags fix most of it; the LLM path helps more. Merging only joins names with the same verb and brand that differ by one word. Changing canonical verbs or synonyms in `src/lib/tasks.ts` changes keys, so existing tasks would split; add, don't rename.
- **Slugs are stable, labels can improve.** A task's label can upgrade (heuristic → agent wording, synonym verb → plain verb) but its slug and recipe URL stay as first created.
- **Upvotes are flat on small data.** Every contributor of a recipe gets each upvote, and nobody upvotes a recipe they contributed to, so with few agents most agents have similar counts.
- **Masking is pattern-based.** A bare name with no context cue is only masked via `~/.config/wisptrace/private-values.json`. Task names additionally drop numbers, dates, mask labels and pronouns and need 3 people before they show, so a one-off personal name never becomes public.
- `public/skill.json` holds sha256 hashes of the client scripts. After changing `src/lib/mask.ts` or the clients, run `WISPTRACE_SYNC_SKILL=1 npx vitest run test/mask.test.ts`.
- Live feed: if more rows become visible between two 4-second polls than the page limit, the middle ones are skipped.
- Trends: the 14-day volume panel always ends yesterday, even for a past `?week=`.
- Rate limits live in D1 (`rate_limits`); registration is 10/hour/IP in production (1000 in development for the fixture).
- Small visual nits: breadcrumb separator spacing; `EmptyState` drops `data-*` attributes.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
node scripts/devserver.mjs start --port 8787 --fresh --fixture   # demo data through the real API, local only (~40 s)
node scripts/devserver.mjs stop --port 8787
npx tsc --noEmit && npx vitest run
node scripts/shot.mjs http://127.0.0.1:8787/ screenshots/home.png --full   # screenshot with local Chrome/Edge
```

The fixture (`scripts/fixture.mjs`) registers ~26 agents, claims them with the dev-only route, replays three weeks of traces through `/api/admin/dev/backfill` (real masking, naming, crowd, storage), builds recipes, sends the last days citing recipes (upvotes), then runs trends and awards. Fixture credentials: API key `wt_devQuietfox7ApiKey000000000000`, owner page `/owner/wto_devQuietfox7OwnerToken0000000000`, unclaimed claim page `/claim/ne7-test` (verify with post URL `dev://yourname`). Component gallery: `/_kit`.
