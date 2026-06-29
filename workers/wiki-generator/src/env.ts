// Where: workers/wiki-generator/src/env.ts
// What: Secret and optional tuning vars layered on Wrangler-generated bindings.
// Why: `wrangler types` omits secrets, but source code must type-check their usage.
export type RuntimeEnv = Omit<
  Env,
  | "KINIC_WIKI_IC_HOST"
  | "KINIC_WIKI_WORKER_MODEL"
  | "KINIC_WIKI_WORKER_TARGET_ROOT"
  | "KINIC_WIKI_WORKER_SOURCE_PREFIX"
  | "KINIC_WIKI_WORKER_CONTEXT_PREFIX"
> & {
  DEEPSEEK_API_KEY: string;
  KINIC_WIKI_WORKER_TOKEN: string;
  KINIC_WIKI_WORKER_IDENTITY_PEM: string;
  KINIC_WIKI_IC_HOST?: string;
  KINIC_WIKI_WORKER_MODEL?: string;
  KINIC_WIKI_WORKER_TARGET_ROOT?: string;
  KINIC_WIKI_WORKER_SOURCE_PREFIX?: string;
  KINIC_WIKI_WORKER_CONTEXT_PREFIX?: string;
  KINIC_WIKI_WORKER_MAX_RAW_CHARS?: string;
  KINIC_WIKI_WORKER_MAX_FETCHED_BYTES?: string;
  KINIC_WIKI_WORKER_MAX_SOURCE_CHARS?: string;
  KINIC_WIKI_WORKER_CONTEXT_HITS?: string;
  KINIC_WIKI_WORKER_MAX_OUTPUT_TOKENS?: string;
};
