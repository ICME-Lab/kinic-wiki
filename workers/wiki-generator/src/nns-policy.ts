// Where: workers/wiki-generator/src/nns-policy.ts
// What: Strict parser and hashing for the Wiki-owned NNS automatic-voting policy.
// Why: A mutable Wiki page must fail closed before it can influence signed votes.
import type { WikiNode } from "./types.js";

export const NNS_AUTOVOTE_POLICY_PATH = "/Knowledge/nns/autovote-policy.md";
export const MIN_AUTOVOTE_THRESHOLD = 0.9;
const MAX_RULES = 32;
const MAX_RULE_CHARS = 500;
const EVIDENCE = new Set<NnsEvidenceKind>(["proposal", "governance", "reference"]);

export type NnsEvidenceKind = "proposal" | "governance" | "reference";
export type NnsPolicyMode = "shadow" | "live";
export type NnsActionPolicy = {
  evaluate: boolean;
  autoVote: boolean;
  autoVoteChoices: ("ADOPT" | "REJECT")[];
  requiredEvidence: NnsEvidenceKind[];
  rules: string[];
};

export type NnsAutovotePolicy = {
  schemaVersion: 1;
  policyVersion: string;
  jevModel: string;
  enabled: boolean;
  mode: NnsPolicyMode;
  minChoiceProbability: number;
  minConfidence: number;
  minNoulProbability: number;
  actions: Record<string, NnsActionPolicy>;
};

export type LoadedNnsPolicy = {
  policy: NnsAutovotePolicy;
  etag: string;
  hash: string;
  content: string;
  valid: boolean;
};

export const DEFAULT_NNS_AUTOVOTE_POLICY = `---
kind: kinic.nns_autovote_policy
schema_version: 1
policy_version: "initial-shadow"
jev_model: "jev-latest"
enabled: false
mode: shadow
min_choice_probability: 0.95
min_confidence: 0.90
min_noul_probability: 0.90
actions:
  default:
    evaluate: true
    auto_vote: false
    required_evidence: [proposal, governance]
    rules:
      - "Use HOLD unless the captured evidence directly supports the decision."
---

# NNS Automatic Voting Policy

This version evaluates every proposal in shadow mode. Add an exact action name and set
\`auto_vote: true\` only after that action and vote direction pass the shadow evaluation gate.
`;

export class NnsPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NnsPolicyError";
  }
}

export async function loadNnsPolicyNode(node: WikiNode | null): Promise<LoadedNnsPolicy> {
  if (!node || node.kind !== "file") throw new NnsPolicyError("automatic-voting policy is missing or is not a file");
  const policy = parseNnsAutovotePolicy(node.content);
  return { policy, etag: node.etag, hash: await sha256Hex(node.content), content: node.content, valid: true };
}

export function parseNnsAutovotePolicy(content: string): NnsAutovotePolicy {
  const header = frontmatter(content);
  const root = scalarMap(header.lines.filter((line) => indent(line) === 0 && line.trim() !== "actions:"));
  if (root.kind !== "kinic.nns_autovote_policy") throw new NnsPolicyError("policy kind is invalid");
  if (root.schema_version !== "1") throw new NnsPolicyError("policy schema_version must be 1");
  const policyVersion = requiredText(root.policy_version, "policy_version", 128);
  const jevModel = requiredText(root.jev_model ?? "jev-latest", "jev_model", 128);
  const enabled = requiredBoolean(root.enabled, "enabled");
  const mode = root.mode === "shadow" || root.mode === "live" ? root.mode : null;
  if (!mode) throw new NnsPolicyError("policy mode must be shadow or live");
  const minChoiceProbability = threshold(root.min_choice_probability, "min_choice_probability");
  const minConfidence = threshold(root.min_confidence, "min_confidence");
  const minNoulProbability = threshold(root.min_noul_probability, "min_noul_probability");
  const actions = parseActions(header.lines);
  if (!actions.default) throw new NnsPolicyError("policy actions.default is required");
  return {
    schemaVersion: 1,
    policyVersion,
    jevModel,
    enabled,
    mode,
    minChoiceProbability,
    minConfidence,
    minNoulProbability,
    actions
  };
}

export function actionPolicy(policy: NnsAutovotePolicy, action: string): NnsActionPolicy {
  const direct = policy.actions[action];
  if (direct) return direct;
  const normalized = normalizeActionKey(action);
  const equivalent = Object.entries(policy.actions).find(([key]) => key !== "default" && normalizeActionKey(key) === normalized)?.[1];
  return equivalent ?? policy.actions.default!;
}

export function policyAllowsVote(policy: NnsAutovotePolicy, action: string, choice?: "ADOPT" | "REJECT"): boolean {
  const selected = actionPolicy(policy, action);
  return policy.enabled && policy.mode === "live" && selected.evaluate && selected.autoVote
    && (!choice || selected.autoVoteChoices.includes(choice));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseActions(lines: string[]): Record<string, NnsActionPolicy> {
  const actionsLine = lines.findIndex((line) => line.trim() === "actions:" && indent(line) === 0);
  if (actionsLine < 0) throw new NnsPolicyError("policy actions are required");
  const output: Record<string, NnsActionPolicy> = {};
  let current: string | null = null;
  let currentFields: Record<string, string> = {};
  let rules: string[] = [];
  let inRules = false;
  const flush = () => {
    if (!current) return;
    if (Object.keys(output).length >= 256) throw new NnsPolicyError("policy has too many actions");
    if (output[current]) throw new NnsPolicyError(`duplicate policy action: ${current}`);
    const allowedFields = new Set(["evaluate", "auto_vote", "auto_vote_choices", "required_evidence"]);
    const unknownField = Object.keys(currentFields).find((field) => !allowedFields.has(field));
    if (unknownField) throw new NnsPolicyError(`unknown action field: ${current}.${unknownField}`);
    const requiredEvidence = inlineList(currentFields.required_evidence ?? "[]", "required_evidence").map((entry) => {
      if (!EVIDENCE.has(entry as NnsEvidenceKind)) throw new NnsPolicyError(`unknown required evidence: ${entry}`);
      return entry as NnsEvidenceKind;
    });
    output[current] = {
      evaluate: requiredBoolean(currentFields.evaluate, `${current}.evaluate`),
      autoVote: requiredBoolean(currentFields.auto_vote, `${current}.auto_vote`),
      autoVoteChoices: choiceList(currentFields.auto_vote_choices),
      requiredEvidence,
      rules
    };
  };
  for (const line of lines.slice(actionsLine + 1)) {
    const level = indent(line);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (level === 0) break;
    const actionMatch = level === 2 ? trimmed.match(/^([^:\s][^:]*):$/) : null;
    if (actionMatch) {
      flush();
      current = actionMatch[1]!.trim();
      if (!/^(default|[A-Za-z][A-Za-z0-9_]*)$/.test(current)) throw new NnsPolicyError(`invalid action key: ${current}`);
      currentFields = {};
      rules = [];
      inRules = false;
      continue;
    }
    if (!current) throw new NnsPolicyError("policy action field appears before an action name");
    if (level === 4) {
      const match = trimmed.match(/^([a-z_]+):(?:\s*(.*))?$/);
      if (!match) throw new NnsPolicyError(`invalid action field: ${trimmed}`);
      if (match[1] === "rules") {
        if (match[2]?.trim()) throw new NnsPolicyError(`${current}.rules must be a YAML list`);
        inRules = true;
        continue;
      }
      inRules = false;
      if (currentFields[match[1]!] !== undefined) throw new NnsPolicyError(`duplicate action field: ${current}.${match[1]}`);
      currentFields[match[1]!] = match[2]?.trim() ?? "";
      continue;
    }
    if (level === 6 && trimmed.startsWith("- ")) {
      if (!inRules) throw new NnsPolicyError(`${current}.rules list appears without rules`);
      if (rules.length >= MAX_RULES) throw new NnsPolicyError(`${current}.rules exceeds ${MAX_RULES}`);
      const rule = unquote(trimmed.slice(2).trim());
      if (!rule || rule.length > MAX_RULE_CHARS) throw new NnsPolicyError(`${current}.rules contains an invalid rule`);
      rules.push(rule);
      continue;
    }
    throw new NnsPolicyError(`unsupported policy YAML: ${trimmed}`);
  }
  flush();
  return output;
}

function frontmatter(content: string): { lines: string[] } {
  if (!content.startsWith("---\n")) throw new NnsPolicyError("policy frontmatter is required");
  const end = content.indexOf("\n---", 4);
  if (end < 0) throw new NnsPolicyError("policy frontmatter is unterminated");
  return { lines: content.slice(4, end).split("\n") };
}

function scalarMap(lines: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed = new Set([
    "kind", "schema_version", "policy_version", "jev_model", "enabled", "mode",
    "min_choice_probability", "min_confidence", "min_noul_probability"
  ]);
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.trim().match(/^([a-z_]+):\s*(.+)$/);
    if (!match) throw new NnsPolicyError(`unsupported policy field: ${line.trim()}`);
    if (!allowed.has(match[1]!)) throw new NnsPolicyError(`unknown policy field: ${match[1]}`);
    if (result[match[1]!] !== undefined) throw new NnsPolicyError(`duplicate policy field: ${match[1]}`);
    result[match[1]!] = unquote(match[2]!.trim());
  }
  return result;
}

function inlineList(value: string, name: string): string[] {
  if (!value.startsWith("[") || !value.endsWith("]")) throw new NnsPolicyError(`${name} must be an inline list`);
  const body = value.slice(1, -1).trim();
  if (!body) return [];
  return body.split(",").map((part) => unquote(part.trim())).filter(Boolean);
}

function choiceList(value: string | undefined): ("ADOPT" | "REJECT")[] {
  if (value === undefined) return ["ADOPT", "REJECT"];
  const choices = inlineList(value, "auto_vote_choices");
  if (choices.length === 0 || choices.some((choice) => choice !== "ADOPT" && choice !== "REJECT")) {
    throw new NnsPolicyError("auto_vote_choices must contain ADOPT and/or REJECT");
  }
  return [...new Set(choices)] as ("ADOPT" | "REJECT")[];
}

function threshold(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_AUTOVOTE_THRESHOLD || parsed > 1) {
    throw new NnsPolicyError(`${name} must be between ${MIN_AUTOVOTE_THRESHOLD} and 1`);
  }
  return parsed;
}

function requiredText(value: string | undefined, name: string, max: number): string {
  if (!value || value.length > max) throw new NnsPolicyError(`${name} is required and must be at most ${max} characters`);
  return value;
}

function requiredBoolean(value: string | undefined, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new NnsPolicyError(`${name} must be true or false`);
}

function indent(line: string): number {
  return line.length - line.trimStart().length;
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : value;
    } catch {
      throw new NnsPolicyError("policy contains invalid quoted text");
    }
  }
  return value;
}

function normalizeActionKey(value: string): string {
  return value.toLowerCase().replace(/^action_?/, "").replace(/[^a-z0-9]/g, "");
}
