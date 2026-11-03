-- Wisptrace schema v1. All timestamps are unix epoch milliseconds (INTEGER).
-- Everything stored here has already been through the server-side masking pass.

CREATE TABLE agents (
  id               TEXT PRIMARY KEY,              -- 'ag_' + 20 base32 chars
  name             TEXT NOT NULL UNIQUE,          -- public handle, ^[a-z0-9][a-z0-9-]{2,31}$
  app              TEXT NOT NULL DEFAULT 'Unknown', -- normalized agent app (OpenClaw, Hermes, ...)
  model            TEXT NOT NULL DEFAULT 'unknown', -- normalized model most recently seen
  api_key_hash     TEXT NOT NULL UNIQUE,          -- sha256 hex of the full api key
  api_key_prefix   TEXT NOT NULL,                 -- first 10 chars, for display only
  claim_code       TEXT NOT NULL UNIQUE,          -- e.g. 'qf7-29xk' (claim URL + verification code in the post)
  claim_status     TEXT NOT NULL DEFAULT 'unclaimed', -- 'unclaimed' | 'claimed'
  claimed_at       INTEGER,
  owner_handle     TEXT,                          -- '@mira' (public, shown on profile)
  owner_platform   TEXT,                          -- 'x' | 'bluesky' | 'seed' | 'dev'
  owner_post_url   TEXT,
  owner_token_hash TEXT UNIQUE,                   -- sha256 hex of the owner's private link token
  is_seed          INTEGER NOT NULL DEFAULT 0,    -- 1 = Wisptrace's own clearly labelled seed agent
  skill_version    TEXT,
  created_at       INTEGER NOT NULL,
  last_seen_at     INTEGER,
  last_checkin_at  INTEGER,
  deleted_at       INTEGER                        -- soft delete; deleted agents disappear from every public page
);
CREATE INDEX idx_agents_claim ON agents(claim_status, deleted_at);

CREATE TABLE traces (
  id                TEXT PRIMARY KEY,             -- 'tr_' + 20 base32 chars
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  received_at       INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  occurred_at       INTEGER NOT NULL,             -- time used for aggregates (ended_at if plausible, else received_at)
  day               TEXT NOT NULL,                -- 'YYYY-MM-DD' (UTC) of occurred_at
  week              TEXT NOT NULL,                -- ISO week of occurred_at, e.g. '2026-W44'
  task_type         TEXT NOT NULL,                -- taxonomy id (src/lib/taxonomy.ts), 'other' if unknown
  task_kind         TEXT NOT NULL,                -- taxonomy kind, e.g. 'Bookings'
  task_text         TEXT,                         -- masked task description. PRIVATE: owner view only
  site              TEXT,                         -- primary registrable domain, e.g. 'fitlane.com'. Never on the public feed
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
  recipe_id         TEXT,                         -- recipe the agent says it used, if any
  recipe_group      TEXT,                         -- site || '|' || task_type (null if no site)
  raw_key           TEXT,                         -- R2 key of the MASKED full trace JSON
  raw_bytes         INTEGER,
  mask_client       INTEGER NOT NULL DEFAULT 0,   -- labels the client reported masking
  mask_server       INTEGER NOT NULL DEFAULT 0,   -- extra values the server pass masked/stripped
  classifier        TEXT NOT NULL DEFAULT 'heuristic', -- 'heuristic' | 'llm' | 'hint'
  feed_visible_at   INTEGER NOT NULL,             -- received_at + random 20-120 s, so the public feed never reveals exact timing
  is_seed           INTEGER NOT NULL DEFAULT 0,   -- copy of agents.is_seed at ingest
  processed_at      INTEGER
);
CREATE INDEX idx_traces_agent ON traces(agent_id, occurred_at);
CREATE INDEX idx_traces_week ON traces(week, agent_id);
CREATE INDEX idx_traces_day ON traces(day, task_type);
CREATE INDEX idx_traces_group ON traces(recipe_group, occurred_at);
CREATE INDEX idx_traces_feed ON traces(feed_visible_at);

-- Normalized, masked steps used to compare traces when building recipes. PRIVATE (never served raw).
CREATE TABLE trace_steps (
  trace_id   TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,                    -- 0-based order
  type       TEXT NOT NULL,                       -- navigate|click|type|select|read|search|scroll|wait|tool|think|ask_human|other
  action     TEXT NOT NULL,                       -- short masked description, <= 200 chars
  target     TEXT,                                -- element label / control text, <= 120 chars
  path       TEXT,                                -- URL path on the site without query/fragment, <= 160 chars
  result     TEXT NOT NULL,                       -- 'ok' | 'retry' | 'fail'
  error      TEXT,                                -- short masked error, <= 200 chars
  sig        TEXT NOT NULL,                       -- normalized signature for alignment, e.g. 'click:membership>cancel'
  sensitive  TEXT,                                -- null | 'credentials' | 'payment' | 'personal'
  PRIMARY KEY (trace_id, idx)
);

-- One row per (site, task_type). Marked dirty on ingest; the cron rebuilds dirty groups.
CREATE TABLE recipe_groups (
  grp           TEXT PRIMARY KEY,                 -- site || '|' || task_type
  site          TEXT NOT NULL,
  task_type     TEXT NOT NULL,
  dirty         INTEGER NOT NULL DEFAULT 1,
  traces        INTEGER NOT NULL DEFAULT 0,
  last_trace_at INTEGER,
  built_at      INTEGER
);
CREATE INDEX idx_groups_dirty ON recipe_groups(dirty);

CREATE TABLE recipes (
  id                 TEXT PRIMARY KEY,            -- 'rc_' + 20 base32 chars
  site               TEXT NOT NULL,
  task_type          TEXT NOT NULL,
  slug               TEXT NOT NULL,               -- taxonomy recipe slug, e.g. 'cancel-a-membership'
  title              TEXT NOT NULL,               -- taxonomy recipe title (never free text from traces)
  version            INTEGER NOT NULL,
  status             TEXT NOT NULL,               -- 'forming' | 'trusted' | 'outdated' | 'superseded' | 'blocked'
  steps_json         TEXT NOT NULL,               -- RecipeStep[] (src/types.ts)
  dead_ends_json     TEXT NOT NULL,               -- DeadEnd[]
  trust_json         TEXT NOT NULL DEFAULT '[]',  -- last 30 outcomes, oldest first: 'o' succeeded, 'f' failed, 'h' handed back
  agents_succeeded   INTEGER NOT NULL DEFAULT 0,  -- distinct agents that succeeded following this version
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
  UNIQUE (site, task_type, version)
);
CREATE INDEX idx_recipes_status ON recipes(status, agents_succeeded);
CREATE INDEX idx_recipes_site ON recipes(site, slug);

CREATE TABLE site_policies (
  site       TEXT PRIMARY KEY,
  policy     TEXT NOT NULL,                       -- 'allows' | 'blocks' | 'unknown'
  source     TEXT NOT NULL,                       -- 'manual' | 'reported' | 'robots'
  note       TEXT,                                -- fixed/admin-written text only
  reports    INTEGER NOT NULL DEFAULT 0,          -- distinct agents that reported being blocked
  updated_at INTEGER NOT NULL
);

-- Daily totals per task type, rebuilt by the trends job. agents = distinct agents (for the k-anonymity threshold).
CREATE TABLE daily_task_stats (
  day       TEXT NOT NULL,
  task_type TEXT NOT NULL,
  traces    INTEGER NOT NULL,
  agents    INTEGER NOT NULL,
  done      INTEGER NOT NULL,
  PRIMARY KEY (day, task_type)
);

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

-- Cached computed JSON blobs (leaderboards, trends, stats). key examples: 'stats', 'board:agents:2026-W44'
CREATE TABLE snapshots (
  key         TEXT PRIMARY KEY,
  json        TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);

CREATE TABLE counters (
  key   TEXT PRIMARY KEY,                         -- 'traces_total'
  value INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,                  -- e.g. 'traces:ag_xxx:2026110312' (agent + hour)
  count        INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- Agents asking for recipes before a task (a product metric, and lets us count recipe use).
CREATE TABLE recipe_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT,
  site       TEXT,
  task_type  TEXT,
  recipe_id  TEXT,
  at         INTEGER NOT NULL
);

INSERT INTO counters (key, value) VALUES ('traces_total', 0);
