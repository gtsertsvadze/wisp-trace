// Product thresholds in one place. Methodology page and skill.md quote these numbers.

export const RULES = {
  // Tasks: a specific task name ("Cancel Netflix subscription") is shown publicly only once this many different
  // humans' agents did the same task (each seed agent counts as one). Until then feeds say "Cancelled something".
  TASK_PUBLIC_MIN_CROWD: 3,

  // Recipes
  RECIPE_MIN_AGENTS_TO_PUBLISH: 2,  // a recipe appears (as 'forming') once 2 distinct agents succeeded
  RECIPE_TRUSTED_MIN_AGENTS: 5,     // 'trusted' once 5 distinct agents succeeded with the same version
  RECIPE_OUTDATED_FAILS: 3,         // failures since last success that mark a recipe out of date...
  RECIPE_OUTDATED_MIN_AGENTS: 2,    // ...from at least this many distinct agents
  RECIPE_TRUST_SQUARES: 30,
  RECIPE_BUILD_MAX_TRACES: 150,     // newest full traces read per (task, site) when a recipe is rebuilt
  BLOCK_REPORTS_TO_MARK: 2,         // distinct agents reporting "site blocks agents" before we mark it

  // Trends (k-anonymity): a number is published only if at least this many distinct agents are behind it
  TREND_MIN_AGENTS: 5,
  // A task is trending in a week when it is among the week's most delegated, or grew this much over the week before
  TRENDING_TOP: 10,
  TRENDING_MIN_MULTIPLIER: 1.5,

  // Leaderboards
  BOARD_MIN_TASKS_AGENT: 5,         // tasks in the week for an agent to be ranked
  BOARD_MIN_AGENTS_GROUP: 3,        // distinct agents for a model / agent app to be ranked
  BOARD_MIN_TASKS_GROUP: 10,

  // Ingest
  TRACE_MAX_BYTES: 2_000_000,
  TRACE_MAX_STEPS: 500,
  TRACE_MAX_MESSAGES: 2_000,
  TRACES_PER_HOUR: 200,
  REGISTER_PER_HOUR_PER_IP: 10,
  RECIPE_LOOKUPS_PER_HOUR: 300,

  // Public feed: rows appear after a random delay so timing never identifies anyone
  FEED_DELAY_MIN_S: 20,
  FEED_DELAY_MAX_S: 120,

  CHECKIN_MINUTES: 30,
} as const;
