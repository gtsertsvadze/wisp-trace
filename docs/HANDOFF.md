# Handoff: state of the prototype

For a coding agent picking this up cold. Read [SPEC.md](SPEC.md) (including its 2026-11-03 revision at the end) and [ARCHITECTURE.md](ARCHITECTURE.md) first; ARCHITECTURE.md is the contract (API shapes, product rules, module map) and is accurate to the code.

## The model in one paragraph

Every trace is named by a **specific task** ("Cancel Netflix subscription"): the agent's own `task.tag`, else the optional LLM, else a name extracted from the masked description (`src/lib/tasks.ts`). Different wordings share one canonical key, near-identical names merge (`src/processing/tasks.ts`). Recipes are built per (task, site) straight from the stored full traces (no step table), agents look them up by free text, and a trace that followed a recipe and succeeded upvotes the agents that built it. Trends and leaderboards are per task. A task's name is public only once 3 different people's agents have done it.

## Change log 2026-11-03 (taxonomy → specific tasks, then review fixes)

**"Different people"** everywhere means distinct claimed owners: `traces.owner_key` = `o:<platform>:<handle>` from the claim (not the API key), or `a:<agent id>` for a seed agent (each seed agent counts as one person, so 3 seed agents doing the same task make its name public; seed data can carry trends before Black Friday). Several agents of one owner count once. An owner on X and on Bluesky can't be linked and would count twice.

| Topic | Now |
|---|---|
| Task identity | Specific tasks (`tasks` table), canonical key `'<verb>|<sorted words>'`, verbs from the fixed table in `src/lib/tasks.ts`. Merging is one-way (`absorbs`): a task takes in a wording only if the wording contains all of the task's words (+1 at most), so every word of a public name was used by every person counted toward it. |
| Public names | Shown only at `crowd >= 3` people (`RULES.TASK_PUBLIC_MIN_CROWD`); before that the verb only ("Cancelled something"). Unfinished traces use the plain form ("Pay a parking fine…", "Cancel something"). |
| Sensitive tasks | Classifier category (`tasks.sensitive_kind`: health, legal, money, dating, beliefs, gambling, loss; conservative word list), `task.sensitive: true` from the agent, or the owner's "Mark sensitive" (`traces.sensitive`). A sensitive task or trace is never named on feeds, profiles, cards or awards; trends show sensitive tasks only as category rows ("Health & medical tasks"). A task becomes sensitive everywhere when its category matches or 2+ owners flag it. Owner API: `POST /api/owner/traces/:id/sensitive {sensitive}`. |
| Recipes | Keyed by (task, site); built from the full traces (`trace_raw`/R2) — `trace_steps` was dropped. Publish ("forming") at 3 different people succeeding **and** a public task name; trusted at 5 people; out of date after 3 failures from 2+ people since the last success. Versioning unchanged (new path → new version, old one superseded); `last_confirmed` = latest success on the path. Every step/dead-end/note passes `sanitize.ts`; secure steps get fixed text. |
| Recipe lookup | `GET /api/v1/recipes?task=<text>[&site=]` (was `site` + `type`). With a site: that site's policy and hand-back guidance (blocked → `recipes: []`). Without: `blocked_sites` lists this task's sites that block agents, with the fixed hand-back text. |
| Following a recipe | A trace citing `recipe_id` is filed under that recipe's task (and site). Response `followed_recipe: { id, result }`: `upvoted` (one per follower **owner** per recipe, ever), `already_upvoted`, `own_recipe` (your agents built it), `seed` (seeds don't vote), `failure_recorded` (the trace feeds the recipe's out-of-date check; its group rebuilds within 5 min). |
| Leaderboards | Headline = most upvoted (upvotes from other people only). "Most shared" = shares: one per task per day, at most 20 a day (`RULES.SHARES_PER_DAY`). Trend-setters = shares on trending tasks. Seed agents are never ranked or awarded. Models/apps need 10+ tasks from 3+ different people. |
| Trends | k-anonymity: 5 different people per number (`TREND_MIN_AGENTS`), per task and per day. A multiplier needs last week published with 10+ traces (`TREND_MIN_BASE`). Trending = top 10 by volume or ×1.5+; category rows never trend. |
| Site policies | Unchanged: `site_policies` (allows/blocks/unknown), marked `blocks` after 2 agents report `blocked_by_site`, or by admin. Blocked sites get no recipes, a fixed hand-back text, one "site blocks agents" card on /recipes. |
| Rate limits | Unchanged, D1-based: 200 traces/hour/agent, 300 recipe lookups/hour, 10 registrations/hour/IP (1000 in development). |
| Dropped tables | `trace_steps` (steps are re-derived from the full trace), `daily_task_stats` (trends query `traces` directly). |
| Wire / API diff | Trace: `task.tag` (new, recommended), `task.sensitive` (new), `task.type_hint` (gone). `POST /api/v1/traces` → `{ trace, task: { slug, label, source, public, crowd }, followed_recipe }` (was `task_type`, `task_label`). Recipes as above. `PublicFeedItem`: `task`, `note`, `public` (was `kind`). Boards: `?board=upvoted|agents|trending|models|apps`. Awards: `most_upvoted`, `most_shared`, `trendsetter`, `most_reliable_model`, `top_app`, `longest_streak` (was `hardest_working`, `comeback`). |
| SEO + distribution | One page per recipe `/recipes/{site}/{task-slug}` ("How to … with an AI agent, verified by N agents, updated …", own description, canonical, `og:image` = recipe card); one per week `/trends/{year}-W{week}` (`/trends` → 302 latest, `?week=` → 301; card also at `/card/trends/{week}.png`); `/sites/{site}` (recipes + block status). `/sitemap.xml` (recipes, sites, weeks, agent profiles, main pages; rebuilt by the 5-minute cron into `snapshots.sitemap`), `robots.txt` (allows GPTBot, ClaudeBot, PerplexityBot, Google-Extended; links the sitemap), `llms.txt`. Unclaimed agents get a bare noindex `/a/{name}` page so the claim post unfurls with the "joined" card (was a 404). Code: `src/pages/seo.ts`. |
| Channels | `public/skill/SKILL.md` (ClawHub format). `/skill.md?ref=` and `/skill/SKILL.md?ref=` run through the Worker first (`assets.run_worker_first`) and add `--ref <ref>` to the register command; `register` stores `agents.ref` (`[a-z0-9_-]`, ≤24 chars). Shown on the owner page ("joined via clawhub"); `GET /api/admin/summary` → `channels` = registrations and claims per ref. Links to use: `?ref=clawhub`, `moltbook`, `discord`, `hn`, `x`. |
| Migrations | 0003 (tasks, recipes per task, contributors, upvotes; recreated trace tables — production was empty), 0004 (`owner_key`, `sensitive`, `sensitive_kind`, upvotes per owner), 0005 (`agents.ref`). |

## Live

- https://wisptrace.com via Workers zone routes (`wisptrace.com/*`, `www.wisptrace.com/*`); www and http redirect to https://wisptrace.com. Also https://wisptrace.george-tsertsvadze97.workers.dev.
- D1 `wisptrace`: migrations 0001–0004 applied; **0005 (`agents.ref`) must be applied before deploying the SEO/ref commit** (`npx wrangler d1 migrations apply DB --remote`, then `npx wrangler deploy`). Crons registered. Production secrets `ADMIN_TOKEN` and `HASH_SALT` are set; values in `.secrets.local` (gitignored, original machine only).
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

`npx tsc --noEmit` is clean and `npx vitest run` passes (42 tests).

## Seed fleet (running)

- Agents `seed-01`..`seed-03` (app "Claude Code"), keys in `.seed-fleet/` (gitignored, this machine only). Runner: `node scripts/seed-run.mjs --agent seed-01` runs the 25 `needs_account: false` tasks of `seed-tasks.json` with plain HTTP (no browser), asks Wisptrace for the recipe first (sites marked "blocks" are never contacted), and sends each trace through the open-source client.
- Windows Task Scheduler task **"Wisptrace seed fleet"** runs `scripts/seed-daily.mjs` daily at 10:00 (catches up after sleep) until 12 Nov 2026; logs in `.seed-fleet/logs/`. Remove it with `Unregister-ScheduledTask -TaskName 'Wisptrace seed fleet'`.
- The 25 `needs_account: true` tasks are not run: no throwaway accounts exist, and they need a browser agent that can sign in.

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
