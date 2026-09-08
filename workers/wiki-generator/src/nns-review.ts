// Where: workers/wiki-generator/src/nns-review.ts
// What: NNS proposal normalization, review validation, and deterministic Markdown rendering.
// Why: Official API snapshots and AI opinions must remain separate, bounded, and free of voting data.
import { renderFrontmatter } from "./frontmatter.js";
import { extractDeepSeekResponseText } from "./openai.js";
import type { FetchedUrlSource } from "./url-fetch.js";

export type NnsRecommendation = "ADOPT" | "REJECT" | "NEEDS_CLARIFICATION" | "NOT_APPLICABLE";
export type NnsReviewDepth = "basic" | "focused";
export type NnsReviewStatus = "ai_generated" | "skipped_not_open";

export type NnsProposalSnapshot = {
  proposalId: number;
  title: string;
  summary: string;
  topic: string;
  proposalUrl: string | null;
  action: string;
  statusAtCapture: string;
  capturedAt: string;
  apiUrl: string;
  rawRecord: Record<string, unknown>;
  truncated: boolean;
};

export type NnsCapturedInput = {
  schemaVersion: 1;
  snapshot: NnsProposalSnapshot;
  referenceStatus: "pending" | "captured" | "unavailable";
  reference: FetchedUrlSource | null;
};

export type NnsReviewDraft = {
  executiveSummary: string;
  proposedAction: string;
  evidenceReviewed: string[];
  benefits: string[];
  risks: string[];
  missingInformation: string[];
  typeSpecificChecks: string[];
  recommendation: Exclude<NnsRecommendation, "NOT_APPLICABLE">;
  rationale: string;
};

export type NnsArtifactNode = {
  path: string;
  kind: "file" | "source";
  content: string;
  metadataJson: string;
};

export type NnsGeneratedArtifact = {
  schemaVersion: 1;
  proposalId: number;
  capturedAt: string;
  action: string;
  topic: string;
  statusAtCapture: string;
  reviewDepth: NnsReviewDepth;
  reviewStatus: NnsReviewStatus;
  recommendation: NnsRecommendation;
  model: string;
  llmDurationMs: number | null;
  source: NnsArtifactNode;
  reference: NnsArtifactNode | null;
  review: NnsArtifactNode;
};

export type NnsIndexEntry = {
  proposalId: number;
  action: string;
  topic: string;
  statusAtCapture: string;
  reviewDepth: NnsReviewDepth;
  reviewStatus: NnsReviewStatus;
  recommendation: NnsRecommendation;
  reviewPath: string;
};

const FOCUSED_ACTIONS = new Set(["motion", "managenetworkeconomics", "createservicenervoussystem"]);
const REVIEW_RECOMMENDATIONS = new Set<NnsReviewDraft["recommendation"]>(["ADOPT", "REJECT", "NEEDS_CLARIFICATION"]);
const REVIEW_KEYS = new Set([
  "executive_summary",
  "proposed_action",
  "evidence_reviewed",
  "benefits",
  "risks",
  "missing_information",
  "type_specific_checks",
  "recommendation",
  "rationale"
]);
const VOTING_OR_OUTCOME_KEYS = [
  /^proposer$/,
  /^proposer_name$/,
  /^dfinity_proposer$/,
  /(^|_)ballots?($|_)/,
  /(^|_)known_neurons?($|_)/,
  /(^|_)tally($|_)/,
  /(^|_)voting_power($|_)/,
  /(^|_)decided_(at|timestamp)/,
  /(^|_)decision_(at|timestamp)/,
  /(^|_)executed_(at|timestamp)/,
  /(^|_)failed_(at|timestamp)/,
  /(^|_)settled_(at|timestamp)/,
  /(^|_)reward_(event|status)/,
  /(^|_)derived_proposal_information($|_)/,
  /^failure_reason$/,
  /^success_value$/
];
const PROPOSAL_RECORD_KEYS = [
  "proposal_id",
  "title",
  "summary",
  "topic",
  "url",
  "action",
  "payload",
  "proposal_timestamp_seconds",
  "deadline_timestamp_seconds",
  "reject_cost_e8s"
] as const;

export const DEFAULT_NNS_REVIEW_POLICY = `# NNS Proposal Review Policy

This database provides AI-generated, pre-vote decision support. It is an administrator-controlled public record, not an immutable or trustless audit log.

## Recommendation rules

- ADOPT only when the proposed action is explicit, material claims are supported by captured evidence, and no material risk remains unresolved.
- REJECT only when captured evidence demonstrates a material contradiction, an unsafe or unbounded action, or a violation of this policy.
- NEEDS_CLARIFICATION whenever material evidence, baseline values, units, implementation ownership, or consequences are unclear.
- Do not infer facts from outside the captured proposal and reference evidence.
- Do not evaluate ballots, neurons, voting power, tallies, final outcomes, or execution results.
`;

export class NnsProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NnsProposalValidationError";
  }
}

export class NnsReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NnsReviewValidationError";
  }
}

export function parseProposalDetailResponse(body: unknown, proposalId: number, apiUrl: string, capturedAt: string, maxSourceChars: number): NnsProposalSnapshot {
  const candidate = unwrapApiData(body);
  if (!isObject(candidate)) throw new NnsProposalValidationError("proposal detail must be an object");
  const actualId = positiveInteger(candidate.proposal_id);
  if (actualId !== proposalId) throw new NnsProposalValidationError("proposal detail id does not match requested id");

  const action = firstNonEmptyString(candidate.action, candidate.action_nns_function, candidate.self_describing_action) ?? "Unknown";
  const statusAtCapture = requiredText(candidate.status, "proposal status");
  const sanitized = sanitizeProposalRecord(candidate);
  sanitized.action = action;
  sanitized.status_at_capture = statusAtCapture;
  const bounded = boundProposalRecord(sanitized, maxSourceChars);
  return {
    proposalId,
    title: optionalText(candidate.title) ?? `NNS Proposal ${proposalId}`,
    summary: optionalText(candidate.summary) ?? "",
    topic: optionalText(candidate.topic) ?? "Unknown",
    proposalUrl: optionalHttpUrl(candidate.url),
    action,
    statusAtCapture,
    capturedAt,
    apiUrl,
    rawRecord: bounded.record,
    truncated: bounded.truncated
  };
}

export function sanitizeProposalRecord(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of PROPOSAL_RECORD_KEYS) {
    if (key in value) output[key] = sanitizeValue(value[key]);
  }
  return output;
}

export function reviewDepthForAction(action: string): NnsReviewDepth {
  return FOCUSED_ACTIONS.has(normalizedAction(action)) ? "focused" : "basic";
}

export function isOpenAtCapture(status: string): boolean {
  return status.trim().toUpperCase() === "OPEN";
}

export function nnsReviewMessages(
  snapshot: NnsProposalSnapshot,
  policy: string,
  reference: FetchedUrlSource | null,
  maxRawChars: number
): { role: "system" | "user"; content: string }[] {
  const depth = reviewDepthForAction(snapshot.action);
  const focusedRules = focusedRulesForAction(snapshot.action);
  const schema = {
    executive_summary: "string",
    proposed_action: "string",
    evidence_reviewed: ["string"],
    benefits: ["string"],
    risks: ["string"],
    missing_information: ["string"],
    type_specific_checks: ["string"],
    recommendation: "ADOPT | REJECT | NEEDS_CLARIFICATION",
    rationale: "string"
  };
  return [
    {
      role: "system",
      content: [
        "You review an NNS proposal using only the evidence supplied in the user message.",
        "Return only one JSON object matching the given schema. Write every field in English.",
        "Never infer ballots, neuron behavior, voting power, tallies, final outcomes, or execution results.",
        "Use ADOPT or REJECT only when the captured evidence satisfies the review policy; otherwise use NEEDS_CLARIFICATION.",
        snapshot.truncated ? "The official record was truncated. The recommendation MUST be NEEDS_CLARIFICATION." : "",
        `Review depth: ${depth}.`,
        focusedRules,
        `Schema: ${JSON.stringify(schema)}`
      ]
        .filter(Boolean)
        .join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        review_policy: policy.slice(0, maxRawChars),
        official_proposal_snapshot: snapshot.rawRecord,
        reference_evidence: reference
          ? {
              requested_url: reference.url,
              final_url: reference.finalUrl,
              title: reference.title,
              content_type: reference.contentType,
              text: reference.text.slice(0, maxRawChars),
              truncated: reference.fetchedTruncated || reference.text.length > maxRawChars
            }
          : null,
        reference_evidence_status: reference ? "captured" : snapshot.proposalUrl ? "unavailable" : "not_provided"
      })
    }
  ];
}

export function parseNnsReviewResponse(body: unknown, sourceTruncated: boolean): NnsReviewDraft {
  return parseNnsReviewText(extractDeepSeekResponseText(body), sourceTruncated);
}

export function parseNnsReviewText(text: string, sourceTruncated = false): NnsReviewDraft {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new NnsReviewValidationError("review response is not valid JSON");
  }
  if (!isObject(value)) throw new NnsReviewValidationError("review response must be an object");
  const unexpected = Object.keys(value).filter((key) => !REVIEW_KEYS.has(key));
  if (unexpected.length > 0) throw new NnsReviewValidationError(`review response has unexpected fields: ${unexpected.join(", ")}`);
  const recommendation = requiredString(value.recommendation, "recommendation") as NnsReviewDraft["recommendation"];
  if (!REVIEW_RECOMMENDATIONS.has(recommendation)) throw new NnsReviewValidationError("review recommendation is invalid");
  const rationale = requiredString(value.rationale, "rationale");
  return {
    executiveSummary: requiredString(value.executive_summary, "executive_summary"),
    proposedAction: requiredString(value.proposed_action, "proposed_action"),
    evidenceReviewed: stringArray(value.evidence_reviewed, "evidence_reviewed"),
    benefits: stringArray(value.benefits, "benefits"),
    risks: stringArray(value.risks, "risks"),
    missingInformation: stringArray(value.missing_information, "missing_information"),
    typeSpecificChecks: stringArray(value.type_specific_checks, "type_specific_checks"),
    recommendation: sourceTruncated ? "NEEDS_CLARIFICATION" : recommendation,
    rationale:
      sourceTruncated && recommendation !== "NEEDS_CLARIFICATION"
        ? `The official proposal snapshot was truncated, so the Worker requires clarification. ${rationale}`
        : rationale
  };
}

export function proposalSourceNode(snapshot: NnsProposalSnapshot): NnsArtifactNode {
  const path = `/Sources/nns/proposals/${snapshot.proposalId}/proposal.md`;
  const record = JSON.stringify(snapshot.rawRecord, null, 2);
  const content = renderFrontmatter(
    {
      kind: "kinic.nns_proposal_snapshot",
      schema_version: 1,
      proposal_id: snapshot.proposalId,
      action: snapshot.action,
      topic: snapshot.topic,
      status_at_capture: snapshot.statusAtCapture,
      captured_at: snapshot.capturedAt,
      api_url: snapshot.apiUrl,
      proposal_url: snapshot.proposalUrl,
      truncated: snapshot.truncated
    },
    [
      `# NNS Proposal ${snapshot.proposalId}: ${singleLine(snapshot.title)}`,
      "",
      `Official API: ${snapshot.apiUrl}`,
      `Captured at: ${snapshot.capturedAt}`,
      "",
      "## Summary",
      "",
      snapshot.summary || "No summary was provided.",
      "",
      "## Sanitized Official API Record",
      "",
      "```json",
      record,
      "```",
      "",
      "> This is an off-chain IC Dashboard API snapshot, not a direct governance-canister proof.",
      "> Voting data, neuron data, tallies, final outcomes, and execution-result fields are intentionally excluded."
    ].join("\n")
  );
  return {
    path,
    kind: "source",
    content,
    metadataJson: JSON.stringify({
      source_type: "nns_proposal",
      proposal_id: snapshot.proposalId,
      action: snapshot.action,
      topic: snapshot.topic,
      status_at_capture: snapshot.statusAtCapture,
      captured_at: snapshot.capturedAt,
      api_url: snapshot.apiUrl,
      truncated: snapshot.truncated
    })
  };
}

export function proposalReferenceNode(snapshot: NnsProposalSnapshot, fetched: FetchedUrlSource, maxSourceChars: number): NnsArtifactNode {
  const path = `/Sources/nns/proposals/${snapshot.proposalId}/reference.md`;
  const limited = limitText(fetched.text, maxSourceChars);
  const title = fetched.title ?? fetched.finalUrl;
  const content = renderFrontmatter(
    {
      kind: "kinic.nns_proposal_reference",
      schema_version: 1,
      proposal_id: snapshot.proposalId,
      url: fetched.url,
      final_url: fetched.finalUrl,
      title,
      content_type: fetched.contentType,
      captured_at: snapshot.capturedAt,
      truncated: limited.truncated || fetched.fetchedTruncated,
      fetched_bytes: fetched.fetchedBytes,
      max_fetched_bytes: fetched.maxFetchedBytes
    },
    [`# ${singleLine(title)}`, "", `Source URL: ${fetched.finalUrl}`, "", limited.text].join("\n")
  );
  return {
    path,
    kind: "source",
    content,
    metadataJson: JSON.stringify({
      source_type: "nns_proposal_reference",
      proposal_id: snapshot.proposalId,
      url: fetched.url,
      final_url: fetched.finalUrl,
      captured_at: snapshot.capturedAt,
      truncated: limited.truncated || fetched.fetchedTruncated
    })
  };
}

export function proposalReviewNode(
  snapshot: NnsProposalSnapshot,
  draft: NnsReviewDraft | null,
  model: string,
  referencePath: string | null
): NnsArtifactNode {
  const sourcePath = `/Sources/nns/proposals/${snapshot.proposalId}/proposal.md`;
  const path = `/Knowledge/nns/proposals/${snapshot.proposalId}/review.md`;
  const reviewDepth = reviewDepthForAction(snapshot.action);
  const skipped = draft === null;
  const recommendation: NnsRecommendation = skipped ? "NOT_APPLICABLE" : draft.recommendation;
  const body = skipped
    ? skippedReviewBody(snapshot)
    : generatedReviewBody(snapshot, draft, sourcePath, referencePath);
  return {
    path,
    kind: "file",
    content: renderFrontmatter(
      {
        kind: "kinic.nns_proposal_review",
        schema_version: 1,
        proposal_id: snapshot.proposalId,
        action: snapshot.action,
        topic: snapshot.topic,
        review_depth: reviewDepth,
        review_status: skipped ? "skipped_not_open" : "ai_generated",
        recommendation,
        generated_at: snapshot.capturedAt,
        model: skipped ? "none" : model,
        proposal_source_path: sourcePath,
        reference_source_path: referencePath
      },
      body
    ),
    metadataJson: JSON.stringify({
      generated_by: "nns-proposal-review-worker",
      proposal_id: snapshot.proposalId,
      action: snapshot.action,
      topic: snapshot.topic,
      review_depth: reviewDepth,
      review_status: skipped ? "skipped_not_open" : "ai_generated",
      recommendation,
      proposal_source_path: sourcePath,
      reference_source_path: referencePath
    })
  };
}

export function renderNnsIndex(entries: NnsIndexEntry[], generatedAt: string): string {
  const rows = entries.map((entry) =>
    `| ${entry.proposalId} | ${escapeTable(entry.action)} | ${escapeTable(entry.topic)} | ${escapeTable(entry.statusAtCapture)} | ${entry.reviewDepth} | ${entry.reviewStatus} | **${entry.recommendation}** | [Review](<${entry.reviewPath}>) |`
  );
  return renderFrontmatter(
    {
      kind: "kinic.nns_proposal_review_index",
      schema_version: 1,
      generated_at: generatedAt,
      proposal_count: entries.length
    },
    [
      "# NNS Proposal Reviews",
      "",
      "> AI-generated pre-vote decision support. This is an administrator-controlled public record, not an immutable audit log.",
      "",
      "No ballots, neurons, voting power, tallies, final outcomes, or execution results are collected.",
      "",
      "| Proposal | Action | Topic | Status at capture | Depth | Review status | Recommendation | Page |",
      "| ---: | --- | --- | --- | --- | --- | --- | --- |",
      ...(rows.length > 0 ? rows : ["| — | — | — | — | — | — | — | — |"])
    ].join("\n")
  );
}

export function parseGeneratedArtifact(value: string): NnsGeneratedArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new NnsProposalValidationError("generated NNS artifact is not valid JSON");
  }
  if (!isObject(parsed) || parsed.schemaVersion !== 1 || !positiveInteger(parsed.proposalId)) {
    throw new NnsProposalValidationError("generated NNS artifact has an invalid shape");
  }
  return parsed as NnsGeneratedArtifact;
}

export function parseCapturedInput(value: string): NnsCapturedInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new NnsProposalValidationError("captured NNS input is not valid JSON");
  }
  if (!isObject(parsed) || parsed.schemaVersion !== 1 || !isProposalSnapshot(parsed.snapshot)) {
    throw new NnsProposalValidationError("captured NNS input has an invalid shape");
  }
  const referenceStatus = parsed.referenceStatus;
  if (referenceStatus !== "pending" && referenceStatus !== "captured" && referenceStatus !== "unavailable") {
    throw new NnsProposalValidationError("captured NNS reference status is invalid");
  }
  const reference = parsed.reference;
  if (referenceStatus === "captured") {
    if (!isFetchedUrlSource(reference)) throw new NnsProposalValidationError("captured NNS reference is invalid");
  } else if (reference !== null) {
    throw new NnsProposalValidationError("uncaptured NNS reference must be null");
  }
  return {
    schemaVersion: 1,
    snapshot: parsed.snapshot,
    referenceStatus,
    reference: referenceStatus === "captured" ? reference : null
  };
}

function generatedReviewBody(snapshot: NnsProposalSnapshot, draft: NnsReviewDraft, sourcePath: string, referencePath: string | null): string {
  return [
    `# NNS Proposal ${snapshot.proposalId} Review`,
    "",
    "> This review was generated by AI from captured evidence. It is decision support, not an official NNS statement or proof of execution.",
    "",
    "## Executive Summary",
    "",
    draft.executiveSummary,
    "",
    "## Proposed Action",
    "",
    draft.proposedAction,
    "",
    "## Evidence Reviewed",
    "",
    list(draft.evidenceReviewed),
    `- [Official proposal snapshot](<${sourcePath}>)`,
    ...(referencePath ? [`- [Captured proposal reference](<${referencePath}>)`] : []),
    "",
    "## Benefits",
    "",
    list(draft.benefits),
    "",
    "## Risks",
    "",
    list(draft.risks),
    "",
    "## Missing Information / Questions",
    "",
    list(draft.missingInformation),
    "",
    "## Type-Specific Checks",
    "",
    list(draft.typeSpecificChecks),
    "",
    "## Recommendation and Rationale",
    "",
    `**${draft.recommendation}**`,
    "",
    draft.rationale,
    "",
    "## AI-Generated Review Disclaimer",
    "",
    "This page was generated by AI using only the evidence linked above. Verify the proposal directly before voting."
  ].join("\n");
}

function skippedReviewBody(snapshot: NnsProposalSnapshot): string {
  return [
    `# NNS Proposal ${snapshot.proposalId} Review`,
    "",
    "## Executive Summary",
    "",
    `No pre-vote AI review was run because the proposal status was ${snapshot.statusAtCapture} when first captured.`,
    "",
    "## Proposed Action",
    "",
    "See the captured official proposal snapshot.",
    "",
    "## Evidence Reviewed",
    "",
    `- [Official proposal snapshot](</Sources/nns/proposals/${snapshot.proposalId}/proposal.md>)`,
    "",
    "## Benefits",
    "",
    "- Not assessed.",
    "",
    "## Risks",
    "",
    "- Not assessed.",
    "",
    "## Missing Information / Questions",
    "",
    "- A pre-vote review window was not available at first capture.",
    "",
    "## Type-Specific Checks",
    "",
    "- Not performed.",
    "",
    "## Recommendation and Rationale",
    "",
    "**NOT_APPLICABLE**",
    "",
    "The Worker does not retrospectively issue a voting recommendation for a proposal that was already non-open when first observed.",
    "",
    "## AI-Generated Review Disclaimer",
    "",
    "No AI analysis was run for this page. The status decision was applied deterministically by the Worker."
  ].join("\n");
}

function focusedRulesForAction(action: string): string {
  switch (normalizedAction(action)) {
    case "motion":
      return "For Motion proposals, check non-binding scope, clarity, supporting evidence, implementation owner, timeline, success criteria, and contradictions.";
    case "managenetworkeconomics":
      return "For ManageNetworkEconomics proposals, extract changed parameters, values, units, and stated effects. Never invent current baselines; missing baselines require NEEDS_CLARIFICATION.";
    case "createservicenervoussystem":
      return "For CreateServiceNervousSystem proposals, check token distribution, developer allocation and vesting, treasury, swap limits, participation bounds, governance parameters, fallback controllers, and referenced evidence.";
    default:
      return "Apply the generic review policy and identify action-specific risks from the captured payload.";
  }
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (VOTING_OR_OUTCOME_KEYS.some((pattern) => pattern.test(normalizedKey))) continue;
    output[key] = sanitizeValue(child);
  }
  return output;
}

function isProposalSnapshot(value: unknown): value is NnsProposalSnapshot {
  return (
    isObject(value) &&
    positiveInteger(value.proposalId) !== null &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    typeof value.topic === "string" &&
    (value.proposalUrl === null || typeof value.proposalUrl === "string") &&
    typeof value.action === "string" &&
    typeof value.statusAtCapture === "string" &&
    typeof value.capturedAt === "string" &&
    typeof value.apiUrl === "string" &&
    isObject(value.rawRecord) &&
    typeof value.truncated === "boolean"
  );
}

function isFetchedUrlSource(value: unknown): value is FetchedUrlSource {
  return (
    isObject(value) &&
    typeof value.url === "string" &&
    typeof value.finalUrl === "string" &&
    (value.title === null || typeof value.title === "string") &&
    typeof value.contentType === "string" &&
    typeof value.text === "string" &&
    typeof value.fetchedTruncated === "boolean" &&
    typeof value.fetchedBytes === "number" &&
    typeof value.maxFetchedBytes === "number"
  );
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isObject(value)) return sanitizeObject(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return sanitizeValue(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
  }
  return value;
}

function boundProposalRecord(record: Record<string, unknown>, maxChars: number): { record: Record<string, unknown>; truncated: boolean } {
  const serialized = JSON.stringify(record);
  if (serialized.length <= maxChars) return { record, truncated: false };
  const payloadJson = JSON.stringify(record.payload ?? null);
  const fixedRecord: Record<string, unknown> = {
    ...record,
    payload: { snapshot_truncated: true, json_preview: "" }
  };
  fitFixedProposalFields(fixedRecord, maxChars);
  let low = 0;
  let high = payloadJson.length;
  let bounded = fixedRecord;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = {
      ...fixedRecord,
      payload: { snapshot_truncated: true, json_preview: payloadJson.slice(0, middle) }
    };
    if (JSON.stringify(candidate).length <= maxChars) {
      bounded = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { record: bounded, truncated: true };
}

function fitFixedProposalFields(record: Record<string, unknown>, maxChars: number): void {
  const shrinkableKeys = ["summary", "title", "url", "topic", "action", "status_at_capture"];
  for (;;) {
    const serializedLength = JSON.stringify(record).length;
    if (serializedLength <= maxChars) return;
    const key = shrinkableKeys
      .filter((candidate) => typeof record[candidate] === "string" && (record[candidate] as string).length > 0)
      .sort((left, right) => (record[right] as string).length - (record[left] as string).length)[0];
    if (!key) throw new NnsProposalValidationError("NNS proposal source limit is too small for required fields");
    const value = record[key] as string;
    record[key] = value.slice(0, Math.max(0, value.length - Math.max(1, serializedLength - maxChars)));
  }
}

function unwrapApiData(value: unknown): unknown {
  if (!isObject(value) || !("data" in value)) return value;
  return value.data;
}

function optionalHttpUrl(value: unknown): string | null {
  const text = optionalText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizedAction(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function requiredText(value: unknown, name: string): string {
  const text = optionalText(value);
  if (!text) throw new NnsProposalValidationError(`${name} is missing`);
  return text;
}

function optionalText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = optionalText(value);
    if (text) return text;
  }
  return null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new NnsReviewValidationError(`${name} must be a non-empty string`);
  if (value.length > 20_000) throw new NnsReviewValidationError(`${name} is too long`);
  return value.trim();
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 30) throw new NnsReviewValidationError(`${name} must be an array with at most 30 items`);
  return value.map((item, index) => requiredString(item, `${name}[${index}]`));
}

function limitText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars).trimEnd(), truncated: true };
}

function list(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None identified from the captured evidence.";
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function escapeTable(value: string): string {
  return singleLine(value).replace(/\|/g, "\\|");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
