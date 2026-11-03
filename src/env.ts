export interface Bindings {
  DB: D1Database;
  TRACES: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT: 'production' | 'development' | string;
  PUBLIC_ORIGIN: string;
  SKILL_VERSION: string;
  ADMIN_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  HASH_SALT?: string;
  DEV_CLAIM_BYPASS?: string;
}

/** Context variables set by middleware. `agent` is set by requireAgent() in src/lib/auth.ts. */
export interface Variables {
  agent: import('./types').AgentRow;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };

export const isDev = (env: Bindings) => env.ENVIRONMENT === 'development';
