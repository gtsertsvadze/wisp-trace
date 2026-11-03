-- Owners and sensitivity (2026-11-03, after review).
-- Every threshold that means "different people" now counts claimed owners, not agents or API keys: a trace stores the
-- owner it came from (owner_key), upvotes are one per follower-owner per recipe, and tasks/traces carry sensitivity.

-- Who a trace counts as: 'o:<platform>:<handle>' for a claimed owner, 'a:<agent id>' for a seed agent (each seed agent is
-- its own "person"; they are Wisptrace's, clearly labelled).
ALTER TABLE traces ADD COLUMN owner_key TEXT NOT NULL DEFAULT '';
-- 1 when the agent marked the task sensitive (task.sensitive) or the owner did later from the owner link.
ALTER TABLE traces ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0;
UPDATE traces SET owner_key = COALESCE((
  SELECT CASE WHEN a.is_seed = 1 OR a.owner_handle IS NULL THEN 'a:' || a.id
              ELSE 'o:' || COALESCE(a.owner_platform, '') || ':' || LOWER(a.owner_handle) END
  FROM agents a WHERE a.id = traces.agent_id), 'a:' || traces.agent_id);
CREATE INDEX idx_traces_task_owner ON traces(task_id, owner_key);
CREATE INDEX idx_traces_week_owner ON traces(week, owner_key);

-- The classifier's category for a sensitive task ('health', 'legal', 'money', 'dating', 'beliefs', 'gambling', 'loss'),
-- null when none. tasks.sensitive is the effective flag: a category, or flagged by >= 2 owners.
ALTER TABLE tasks ADD COLUMN sensitive_kind TEXT;

-- Upvotes: one per (recipe, follower owner), ever.
CREATE TABLE upvotes_new (
  recipe_id   TEXT NOT NULL,
  voter_owner TEXT NOT NULL,                      -- owner_key of the follower
  voter_id    TEXT NOT NULL,                      -- the agent that followed it
  trace_id    TEXT NOT NULL,                      -- the successful trace that cites the recipe (deleting it removes the vote)
  at          INTEGER NOT NULL,
  week        TEXT NOT NULL,
  PRIMARY KEY (recipe_id, voter_owner)
);
INSERT OR IGNORE INTO upvotes_new (recipe_id, voter_owner, voter_id, trace_id, at, week)
  SELECT u.recipe_id, COALESCE(t.owner_key, 'a:' || u.voter_id), u.voter_id, u.trace_id, u.at, u.week
  FROM upvotes u LEFT JOIN traces t ON t.id = u.trace_id;
DROP TABLE upvotes;
ALTER TABLE upvotes_new RENAME TO upvotes;
CREATE INDEX idx_upvotes_week ON upvotes(week, recipe_id);
CREATE INDEX idx_upvotes_trace ON upvotes(trace_id);

DELETE FROM snapshots;
