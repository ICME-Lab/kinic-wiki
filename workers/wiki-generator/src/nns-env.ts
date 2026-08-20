// Where: workers/wiki-generator/src/nns-env.ts
// What: Generated binding refinements and secrets for the dedicated NNS review Worker.
// Why: NNS Queue, D1, and credentials must not leak into the general wiki-generator runtime.
import type { NnsProposalReviewFailureMessage, NnsProposalReviewQueueMessage, NnsWorkerConfig } from "./types.js";

export type NnsRuntimeEnv = Omit<
  NnsWorkerBindings,
  | "KINIC_WIKI_CANISTER_ID"
  | "KINIC_WIKI_IC_HOST"
  | "KINIC_NNS_API_BASE_URL"
  | "KINIC_NNS_REVIEW_MODEL"
  | "KINIC_NNS_MAX_RAW_CHARS"
  | "KINIC_NNS_MAX_FETCHED_BYTES"
  | "KINIC_NNS_MAX_SOURCE_CHARS"
  | "KINIC_NNS_MAX_OUTPUT_TOKENS"
  | "NNS_PROPOSAL_REVIEW_QUEUE"
  | "NNS_PROPOSAL_REVIEW_DLQ"
> & {
  NNS_PROPOSAL_REVIEW_QUEUE: Queue<NnsProposalReviewQueueMessage>;
  NNS_PROPOSAL_REVIEW_DLQ: Queue<NnsProposalReviewFailureMessage>;
  DEEPSEEK_API_KEY: string;
  KINIC_NNS_WORKER_IDENTITY_PEM: string;
  KINIC_NNS_AUDIT_DATABASE_ID?: string;
  KINIC_WIKI_CANISTER_ID: string;
  KINIC_WIKI_IC_HOST?: string;
  KINIC_NNS_API_BASE_URL?: string;
  KINIC_NNS_REVIEW_MODEL?: string;
  KINIC_NNS_MAX_RAW_CHARS?: string;
  KINIC_NNS_MAX_FETCHED_BYTES?: string;
  KINIC_NNS_MAX_SOURCE_CHARS?: string;
  KINIC_NNS_MAX_OUTPUT_TOKENS?: string;
};

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_MAX_RAW_CHARS = 120_000;
const DEFAULT_MAX_FETCHED_BYTES = 5_000_000;
const DEFAULT_MAX_SOURCE_CHARS = 300_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 6_000;

export function loadNnsWorkerConfig(env: NnsRuntimeEnv): NnsWorkerConfig {
  if (!env.KINIC_WIKI_CANISTER_ID) throw new Error("KINIC_WIKI_CANISTER_ID is required");
  return {
    canisterId: env.KINIC_WIKI_CANISTER_ID,
    icHost: env.KINIC_WIKI_IC_HOST || "https://icp0.io",
    model: env.KINIC_NNS_REVIEW_MODEL || DEFAULT_MODEL,
    maxRawChars: positiveInt(env.KINIC_NNS_MAX_RAW_CHARS, DEFAULT_MAX_RAW_CHARS),
    maxFetchedBytes: positiveInt(env.KINIC_NNS_MAX_FETCHED_BYTES, DEFAULT_MAX_FETCHED_BYTES),
    maxSourceChars: positiveInt(env.KINIC_NNS_MAX_SOURCE_CHARS, DEFAULT_MAX_SOURCE_CHARS),
    maxOutputTokens: positiveInt(env.KINIC_NNS_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS)
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value || !/^[1-9][0-9]*$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
