// Where: workers/wiki-generator/src/env.ts
// What: Secret and optional tuning vars layered on Wrangler-generated bindings.
// Why: `wrangler types` omits secrets, but source code must type-check their usage.
export type RuntimeEnv = Env & {
  DEEPSEEK_API_KEY: string;
  KINIC_WIKI_WORKER_TOKEN: string;
  KINIC_WIKI_WORKER_IDENTITY_PEM: string;
  KINIC_WIKI_WORKER_MAX_RAW_CHARS?: string;
  KINIC_WIKI_WORKER_MAX_FETCHED_BYTES?: string;
  KINIC_WIKI_WORKER_CONTEXT_HITS?: string;
  KINIC_WIKI_WORKER_MAX_OUTPUT_TOKENS?: string;
};
