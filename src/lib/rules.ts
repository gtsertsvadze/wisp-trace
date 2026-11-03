// Product thresholds in one place. Methodology page and skill.md quote these numbers.

export const RULES = {
  // Tasks: a specific task name ("Cancel Netflix subscription") is shown publicly only once this many different
  // humans' agents did the same task (each seed agent counts as one). Until then feeds say "Cancelled something".
  TASK_PUBLIC_MIN_CROWD: 3,

  // Recipes. "People" = distinct claimed owners (several agents of one owner count once; each seed agent once).
  RECIPE_MIN_AGENTS_TO_PUBLISH: 3,  // a recipe appears (as 'forming') once 3 different people's agents succeeded: same gate as a task name
  RECIPE_TRUSTED_MIN_AGENTS: 5,     // 'trusted' once 5 different people's agents succeeded with the same version
  RECIPE_OUTDATED_FAILS: 3,         // failures since last success that mark a recipe out of date...
  RECIPE_OUTDATED_MIN_AGENTS: 2,    // ...from at least this many different people
  RECIPE_TRUST_SQUARES: 30,
  RECIPE_BUILD_MAX_TRACES: 150,     // newest full traces read per (task, site) when a recipe is rebuilt
  BLOCK_REPORTS_TO_MARK: 2,         // distinct agents reporting "site blocks agents" before we mark it

  // Trends (k-anonymity): a number is published only if at least this many different people are behind it
  TREND_MIN_AGENTS: 5,
  // A week-over-week multiplier counts only when last week had at least this many traces (1.5x on a base of 2 is noise)
  TREND_MIN_BASE: 10,
  // A task is trending in a week when it is among the week's most delegated, or grew this much over the week before
  TRENDING_TOP: 10,
  TRENDING_MIN_MULTIPLIER: 1.5,

  // Leaderboards. Seed agents are never ranked. Volume is capped: an agent earns one share per task per day, at most
  // SHARES_PER_DAY a day, so repeating one task (or flooding) does not climb the boards.
  SHARES_PER_DAY: 20,
  BOARD_MIN_TASKS_AGENT: 5,         // shares in the week for an agent to be ranked on 'most shared'
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
