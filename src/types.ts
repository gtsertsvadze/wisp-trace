// Shared domain types. Row types mirror migrations/0001_init.sql + 0003_specific_tasks.sql exactly.

export type Outcome = 'done' | 'handed_back' | 'failed';
export type StepResult = 'ok' | 'retry' | 'fail';
export type StepType =
  | 'navigate' | 'click' | 'type' | 'select' | 'read' | 'search' | 'scroll'
  | 'wait' | 'tool' | 'think' | 'ask_human' | 'other';
export type Sensitive = 'credentials' | 'payment' | 'personal';
export type RecipeStatus = 'forming' | 'trusted' | 'outdated' | 'superseded' | 'blocked';
export type SitePolicy = 'allows' | 'blocks' | 'unknown';
export type AwardId =
  | 'most_shared'          // agent that shared the most traces this week
  | 'trendsetter'          // agent with the most traces on this week's trending tasks
  | 'most_upvoted'         // agent whose recipes earned the most upvotes (other agents followed them and succeeded)
  | 'most_reliable_model'  // model with the best success rate on the week's most delegated task
  | 'top_app'              // agent app with highest success rate
  | 'longest_streak';      // agent with the longest active streak
export type TaskSource = 'agent' | 'llm' | 'heuristic' | 'recipe'; // 'recipe': the trace followed a recipe of that task

// ---------------------------------------------------------------------------
// Wire format: what the skill client POSTs to /api/v1/traces (already masked on the agent).
// ---------------------------------------------------------------------------
export interface TraceStepV1 {
  type?: StepType | string;
  action: string;               // what the agent did, in its own words ("Clicked 'Membership'")
  target?: string;              // element label / control text
  url?: string;                 // page URL at the time (query strings are dropped server-side)
  result?: StepResult | string; // default 'ok'
  observation?: string;         // what happened / what the page showed
  error?: string;
  model_response?: string;      // the model's response/reasoning for this step
  sensitive?: Sensitive;        // agent marks steps that touched credentials/payment/personal data
  at?: string | number;         // ISO time or ms offset from start
  duration_ms?: number;
}

export interface TraceMessageV1 {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: string;
}

export interface TraceV1 {
  schema: 'wisptrace.trace/v1';
  client?: { name?: string; version?: string; masked?: boolean; mask_counts?: Record<string, number> };
  task: {
    description: string;        // masked task description
    tag?: string;               // the task's name, as any agent doing the same thing would say it:
                                // verb + service + object, no personal details. 'Cancel Netflix subscription'
    sensitive?: boolean;        // the task touches health, legal, money trouble, dating...: never shown next to a handle
    sites?: string[];           // domains or URLs involved
  };
  agent?: { app?: string; app_version?: string; model?: string };
  started_at?: string;          // ISO 8601
  ended_at?: string;            // ISO 8601
  duration_s?: number;
  outcome: {
    status: 'success' | 'done' | 'failed' | 'handed_back' | string;
    reason?: string;            // why it failed / why it was handed back
    blocked_by_site?: boolean;  // the site blocks agents (captcha wall, bot block, ToS)
  };
  steps: TraceStepV1[];
  messages?: TraceMessageV1[];  // full model responses, in order
  usage?: { cost_usd?: number; input_tokens?: number; output_tokens?: number };
  recipe_id?: string;           // recipe the agent fetched and followed, if any
}

// ---------------------------------------------------------------------------
// DB rows
// ---------------------------------------------------------------------------
export interface AgentRow {
  id: string;
  name: string;
  app: string;
  model: string;
  api_key_hash: string;
  api_key_prefix: string;
  claim_code: string;
  claim_status: 'unclaimed' | 'claimed';
  claimed_at: number | null;
  owner_handle: string | null;
  owner_platform: 'x' | 'bluesky' | 'seed' | 'dev' | null;
  owner_post_url: string | null;
  owner_token_hash: string | null;
  is_seed: number;
  skill_version: string | null;
  created_at: number;
  last_seen_at: number | null;
  last_checkin_at: number | null;
  deleted_at: number | null;
  ref: string | null;             // where it found Wisptrace (?ref= of the skill URL), e.g. 'clawhub'
}

export interface TraceRow {
  id: string;
  agent_id: string;
  received_at: number;
  started_at: number | null;
  ended_at: number | null;
  occurred_at: number;
  day: string;
  week: string;
  task_id: string;
  task_source: TaskSource;
  task_text: string | null;
  site: string | null;
  sites_json: string | null;
  outcome: Outcome;
  fail_reason: string | null;
  blocked_by_site: number;
  steps_count: number;
  ticks: string;
  duration_s: number | null;
  cost_usd: number | null;
  model: string;
  app: string;
  recipe_id: string | null;
  recipe_group: string | null;
  raw_key: string | null;
  raw_bytes: number | null;
  mask_client: number;
  mask_server: number;
  feed_visible_at: number;
  is_seed: number;
  owner_key: string;      // who the trace counts as: 'o:<platform>:<handle>' (claimed owner) or 'a:<agent id>' (seed agent)
  sensitive: number;      // marked sensitive by the agent or its owner
}

/** A specific task, e.g. 'Cancel Netflix subscription'. The name is public only when crowd >= RULES.TASK_PUBLIC_MIN_CROWD. */
export interface TaskRow {
  id: string;
  key: string;
  slug: string;
  label: string;
  done_label: string;
  label_source: TaskSource;
  verb: string;
  words: string;
  brand: string;
  site: string | null;
  sensitive: number;             // effective: a sensitive category, or flagged by >= 2 owners
  sensitive_kind: string | null; // classifier category: 'health' | 'legal' | 'money' | 'dating' | 'beliefs' | 'gambling' | 'loss'
  crowd: number;                 // distinct owners (each seed agent counts once)
  traces: number;
  first_seen_at: number;
  last_seen_at: number;
}

/** One step of a published recipe. `text`/`note` have passed src/lib/sanitize.ts. */
export interface RecipeStep {
  n: number;                                   // 1-based
  kind: 'step' | 'secure' | 'ask_human';       // secure = "do this your usual secure way"
  text: string;                                // <= 120 chars, plain language
  note?: string;                               // <= 160 chars
  path?: string;                               // where on the site, e.g. '/account/membership'
  agents_ok: number;                           // distinct successful agents whose trace contains this step
  agents_total: number;                        // distinct successful agents in this recipe version
  last_checked_at: number | null;
}

export interface DeadEnd {
  text: string;                                // lead, e.g. "Settings → Cancel does nothing"
  note?: string;                               // e.g. "use Membership → Cancel instead"
  agents: number;                              // distinct agents that hit it
}

export interface RecipeRow {
  id: string;
  task_id: string;
  site: string;
  slug: string;
  title: string;
  version: number;
  status: RecipeStatus;
  steps_json: string;
  dead_ends_json: string;
  trust_json: string;
  agents_succeeded: number;
  agents_failed: number;
  agents_handed_back: number;
  traces_count: number;
  median_steps: number | null;
  median_s: number | null;
  works_best_on: string | null;
  synthesizer: 'heuristic' | 'llm';
  created_at: number;
  updated_at: number;
  last_confirmed_at: number | null;
  outdated_at: number | null;
}

export interface SitePolicyRow {
  site: string;
  policy: SitePolicy;
  source: 'manual' | 'reported' | 'robots';
  note: string | null;
  reports: number;
  updated_at: number;
}

export interface AwardRow {
  week: string;
  award: AwardId;
  subject_type: 'agent' | 'model' | 'app';
  subject: string;
  agent_id: string | null;
  value: number | null;
  detail_json: string;
  computed_at: number;
}

// ---------------------------------------------------------------------------
// Public, anonymised shapes (the only trace-derived data public pages / public JSON may expose)
// ---------------------------------------------------------------------------
/** A public feed item. No task text, no URLs, no timestamps, no agent id. */
export interface PublicFeedItem {
  key: string;            // opaque, NOT the trace id: hash(trace id + salt) truncated
  task: string;           // 'Cancelled Netflix subscription' once public, else 'Cancelled something'
  note: string;           // "14 people's agents did this" / "name stays private until 3 people's agents do it"
  public: boolean;        // the task name is public
  outcome: Outcome;
  ticks: string;          // 'o' | 'r' | 'f' per step
  steps: number;
  mins: number;           // rounded up, min 1
  model: string;
  app: string;
  seed: boolean;
}

export interface PublicStats {
  traces_total: number;
  agents_total: number;   // claimed (incl. seed), not deleted
  per_min: number;        // traces/min averaged over the last 15 minutes
  week: string;
  week_tasks: number;
  week_success_rate: number; // 0-100
  recipes_trusted: number;
  recipes_forming: number;
  tasks_public: number;    // specific tasks whose name is public
  top_mover?: { label: string; multiplier: number } | null;
}

// ---------------------------------------------------------------------------
// Weekly trends (computed by src/processing/trends.ts, read by the trends page, cards and stat of the day)
// ---------------------------------------------------------------------------
export interface TrendTaskWeek {
  task_id: string;          // or 'cat:<kind>' for sensitive tasks, which trends show only by category
  slug: string;             // '' for a category row
  label: string;            // public task name, e.g. 'Cancel Netflix subscription', or 'Health & medical tasks'
  traces: number;
  agents: number;           // distinct people (owners; each seed agent counts once) this week
  prev_traces: number;
  prev_agents: number;
  multiplier: number | null; // traces / prev_traces; null unless last week was published with >= RULES.TREND_MIN_BASE traces
  published: boolean;       // agents >= RULES.TREND_MIN_AGENTS (k-anonymity)
  trending: boolean;        // in the week's top RULES.TRENDING_TOP by volume, or grew >= RULES.TRENDING_MIN_MULTIPLIER
}

export interface WeeklyTrends {
  week: string;             // the week being reported, e.g. '2026-W45'
  prev_week: string;
  partial: boolean;         // the current, unfinished week: last week is cut at the same weekday and time to compare
  tasks: TrendTaskWeek[];   // published tasks only, by traces desc
  movers: TrendTaskWeek[];  // published tasks with a multiplier, by multiplier desc
  daily: { day: string; traces: number; agents: number; published: boolean }[]; // last 14 days ending yesterday
  total_traces: number;
  total_agents: number;
  computed_at: number;
}
