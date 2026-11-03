-- Specific tasks instead of a fixed taxonomy (2026-11-03).
-- Every trace is named by a specific task ("Cancel Netflix subscription") taken from the agent's own tag or its task
-- description. Recipes, trends and leaderboards are built per task. The normalized step table is gone: recipes are
-- derived from the stored full traces (trace_raw / R2) directly.
--
-- Production held no traces when this ran (the site opened empty by design), so the trace-derived tables are
-- recreated rather than migrated. Agents, site policies and counters are kept.

DROP TABLE IF EXISTS trace_steps;
DROP TABLE IF EXISTS recipe_groups;
DROP TABLE IF EXISTS recipes;
DROP TABLE IF EXISTS daily_task_stats;
DROP TABLE IF EXISTS recipe_requests;
DROP TABLE IF EXISTS awards;
DROP TABLE IF EXISTS traces;
DELETE FROM trace_raw;
DELETE FROM snapshots;
UPDATE counters SET value = 0 WHERE key = 'traces_total';

-- One row per specific task. A task is identified by its canonical key (src/lib/tasks.ts): the canonical verb plus
-- the sorted content words, e.g. 'cancel|netflix subscription'. Different phrasings of the same task share a key.
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,                 -- 'tk_' + 20 base32 chars
  key           TEXT NOT NULL UNIQUE,             -- canonical identity: '<verb>|<sorted words>'
  slug          TEXT NOT NULL UNIQUE,             -- URL slug of the label: 'cancel-netflix-subscription'
  label         TEXT NOT NULL,                    -- imperative name: 'Cancel Netflix subscription'
  done_label    TEXT NOT NULL,                    -- past tense for feeds: 'Cancelled Netflix subscription'
  label_source  TEXT NOT NULL,                    -- 'agent' | 'llm' | 'heuristic': where the label came from
  verb          TEXT NOT NULL,                    -- canonical verb, e.g. 'cancel' ('' when none was found)
  words         TEXT NOT NULL,                    -- sorted canonical content words, space separated
  brand         TEXT NOT NULL DEFAULT '',         -- brand word from the site, e.g. 'netflix' ('' without a site)
  site          TEXT,                             -- registrable domain first seen with the task
  sensitive     INTEGER NOT NULL DEFAULT 0,       -- health, legal, money trouble, dating...: never shown on a profile
  crowd         INTEGER NOT NULL DEFAULT 0,       -- distinct humans behind it (each seed agent counts once): the name
                                                  -- is public only when crowd >= RULES.TASK_PUBLIC_MIN_CROWD
  traces        INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX idx_tasks_lookup ON tasks(verb, brand);
CREATE INDEX idx_tasks_public ON tasks(crowd, last_seen_at);

CREATE TABLE traces (
  id                TEXT PRIMARY KEY,             -- 'tr_' + 20 base32 chars
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  received_at       INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  occurred_at       INTEGER NOT NULL,             -- time used for aggregates (ended_at if plausible, else received_at)
  day               TEXT NOT NULL,                -- 'YYYY-MM-DD' (UTC) of occurred_at
  week              TEXT NOT NULL,                -- ISO week of occurred_at, e.g. '2026-W44'
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  task_source       TEXT NOT NULL,                -- 'agent' (task.tag) | 'llm' | 'heuristic' (from the description)
  task_text         TEXT,                         -- masked task description. PRIVATE: owner view only
  site              TEXT,                         -- primary registrable domain, e.g. 'fitlane.com'
  sites_json        TEXT,                         -- JSON array of all registrable domains involved
  outcome           TEXT NOT NULL,                -- 'done' | 'handed_back' | 'failed'
  fail_reason       TEXT,                         -- masked, short. PRIVATE
  blocked_by_site   INTEGER NOT NULL DEFAULT 0,   -- agent reported the site blocks agents
  steps_count       INTEGER NOT NULL,
  ticks             TEXT NOT NULL,                -- one char per step, max 60: 'o' worked, 'r' retried, 'f' failed
  duration_s        INTEGER,
  cost_usd          REAL,
  model             TEXT NOT NULL,                -- normalized
  app               TEXT NOT NULL,                -- normalized
  recipe_id         TEXT,                         -- recipe the agent says it followed, if any
  recipe_group      TEXT,                         -- task_id || '|' || site (null without a site)
  raw_key           TEXT,                         -- key of the MASKED full trace JSON (rawstore)
  raw_bytes         INTEGER,
  mask_client       INTEGER NOT NULL DEFAULT 0,   -- labels the client reported masking
  mask_server       INTEGER NOT NULL DEFAULT 0,   -- extra values the server pass masked/stripped
  feed_visible_at   INTEGER NOT NULL,             -- received_at + random 20-120 s, so the public feed never reveals exact timing
  is_seed           INTEGER NOT NULL DEFAULT 0    -- copy of agents.is_seed at ingest
);
CREATE INDEX idx_traces_agent ON traces(agent_id, occurred_at);
CREATE INDEX idx_traces_week ON traces(week, task_id);
CREATE INDEX idx_traces_day ON traces(day, task_id);
CREATE INDEX idx_traces_task ON traces(task_id, agent_id);
CREATE INDEX idx_traces_group ON traces(recipe_group, occurred_at);
CREATE INDEX idx_traces_feed ON traces(feed_visible_at);

-- One row per (task, site). Marked dirty on ingest; the cron rebuilds dirty groups from the raw traces.
CREATE TABLE recipe_groups (
  grp           TEXT PRIMARY KEY,                 -- task_id || '|' || site
  task_id       TEXT NOT NULL,
  site          TEXT NOT NULL,
  dirty         INTEGER NOT NULL DEFAULT 1,
  traces        INTEGER NOT NULL DEFAULT 0,
  last_trace_at INTEGER,
  built_at      INTEGER
);
CREATE INDEX idx_groups_dirty ON recipe_groups(dirty, last_trace_at);
CREATE INDEX idx_groups_site ON recipe_groups(site, traces);

CREATE TABLE recipes (
  id                 TEXT PRIMARY KEY,            -- 'rc_' + 20 base32 chars
  task_id            TEXT NOT NULL,
  site               TEXT NOT NULL,
  slug               TEXT NOT NULL,               -- the task's slug
  title              TEXT NOT NULL,               -- the task's label at build time
  version            INTEGER NOT NULL,
  status             TEXT NOT NULL,               -- 'forming' | 'trusted' | 'outdated' | 'superseded' | 'blocked'
  steps_json         TEXT NOT NULL,               -- RecipeStep[] (src/types.ts) + hidden alignment signatures
  dead_ends_json     TEXT NOT NULL,               -- DeadEnd[] + hidden signatures
  trust_json         TEXT NOT NULL DEFAULT '[]',  -- last 30 outcomes, oldest first: 'o' succeeded, 'f' failed, 'h' handed back
  agents_succeeded   INTEGER NOT NULL DEFAULT 0,  -- distinct agents that succeeded following this version's path
  agents_failed      INTEGER NOT NULL DEFAULT 0,
  agents_handed_back INTEGER NOT NULL DEFAULT 0,
  traces_count       INTEGER NOT NULL DEFAULT 0,
  median_steps       INTEGER,
  median_s           INTEGER,
  works_best_on      TEXT,                        -- e.g. 'claude-sonnet-4.5 · OpenClaw'
  synthesizer        TEXT NOT NULL DEFAULT 'heuristic', -- 'heuristic' | 'llm'
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_confirmed_at  INTEGER,
  outdated_at        INTEGER,
  UNIQUE (task_id, site, version)
);
CREATE INDEX idx_recipes_status ON recipes(status, agents_succeeded);
CREATE INDEX idx_recipes_site ON recipes(site, slug);
CREATE INDEX idx_recipes_task ON recipes(task_id, status);

-- Agents whose successful traces built a recipe version (rewritten on every build). Upvotes credit them.
CREATE TABLE recipe_contributors (
  recipe_id TEXT NOT NULL,
  agent_id  TEXT NOT NULL,
  PRIMARY KEY (recipe_id, agent_id)
);
CREATE INDEX idx_contributors_agent ON recipe_contributors(agent_id);

-- Implicit upvotes: an agent followed a recipe (trace.recipe_id) and succeeded. One per (recipe, voter); contributors
-- never upvote their own recipe.
CREATE TABLE upvotes (
  recipe_id TEXT NOT NULL,
  voter_id  TEXT NOT NULL,                        -- agent that followed the recipe
  trace_id  TEXT NOT NULL,                        -- the successful trace (deleting it removes the vote)
  at        INTEGER NOT NULL,
  week      TEXT NOT NULL,
  PRIMARY KEY (recipe_id, voter_id)
);
CREATE INDEX idx_upvotes_week ON upvotes(week, recipe_id);
CREATE INDEX idx_upvotes_trace ON upvotes(trace_id);

CREATE TABLE awards (
  week         TEXT NOT NULL,                     -- ISO week the award is for
  award        TEXT NOT NULL,                     -- AwardId (src/types.ts)
  subject_type TEXT NOT NULL,                     -- 'agent' | 'model' | 'app'
  subject      TEXT NOT NULL,                     -- agent name / model / app
  agent_id     TEXT,
  value        REAL,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  computed_at  INTEGER NOT NULL,
  PRIMARY KEY (week, award)
);

-- Agents asking for recipes before a task (a product metric).
CREATE TABLE recipe_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT,
  site       TEXT,
  task_id    TEXT,                                -- matched task, null when nothing matched
  recipe_id  TEXT,
  at         INTEGER NOT NULL
);
