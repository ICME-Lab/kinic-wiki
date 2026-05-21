// Where: workers/wiki-generator/src/config.ts
// What: Runtime config normalization for the generator Worker.
// Why: Env vars need validation before queueing or generation.
import type { WorkerConfig } from "./types.js";
import type { RuntimeEnv } from "./env.js";

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TARGET_ROOT = "/Wiki/conversations";
const DEFAULT_SOURCE_PREFIX = "/Sources/raw";
const DEFAULT_CONTEXT_PREFIX = "/Wiki";
const DEFAULT_MAX_RAW_CHARS = 120_000;
const DEFAULT_MAX_FETCHED_BYTES = 1_000_000;
const DEFAULT_CONTEXT_HITS = 8;
const DEFAULT_MAX_OUTPUT_TOKENS = 6_000;

export function loadConfig(env: RuntimeEnv): WorkerConfig {
  const canisterId = required(env.KINIC_WIKI_CANISTER_ID, "KINIC_WIKI_CANISTER_ID");
  return {
    canisterId,
    icHost: env.KINIC_WIKI_IC_HOST || "https://icp0.io",
    model: env.KINIC_WIKI_WORKER_MODEL || DEFAULT_MODEL,
    targetRoot: env.KINIC_WIKI_WORKER_TARGET_ROOT || DEFAULT_TARGET_ROOT,
    sourcePrefix: env.KINIC_WIKI_WORKER_SOURCE_PREFIX || DEFAULT_SOURCE_PREFIX,
    contextPrefix: env.KINIC_WIKI_WORKER_CONTEXT_PREFIX || DEFAULT_CONTEXT_PREFIX,
    maxRawChars: parsePositiveInt(env.KINIC_WIKI_WORKER_MAX_RAW_CHARS, DEFAULT_MAX_RAW_CHARS),
    maxFetchedBytes: parsePositiveInt(env.KINIC_WIKI_WORKER_MAX_FETCHED_BYTES, DEFAULT_MAX_FETCHED_BYTES),
    maxContextHits: parsePositiveInt(env.KINIC_WIKI_WORKER_CONTEXT_HITS, DEFAULT_CONTEXT_HITS),
    maxOutputTokens: parsePositiveInt(env.KINIC_WIKI_WORKER_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS)
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
