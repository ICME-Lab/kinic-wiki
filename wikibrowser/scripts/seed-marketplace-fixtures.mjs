// Where: wikibrowser/scripts/seed-marketplace-fixtures.mjs
// What: creates local marketplace fixture databases and publishes listings.
// Why: marketplace UI needs repeatable local cards for browse/filter visual checks.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_PAYMENT_E8S = "100_000_000";
const DEFAULT_MIN_CYCLES = "1_000_000";
const DEFAULT_ALLOWANCE_E8S = "400_000_000";

const FIXTURES = [
  {
    name: "Market Seed: AI Research",
    title: "AI Research Notes",
    description: "Curated wiki notes for model evaluation, retrieval, and prompt ops.",
    tags: ["ai", "research", "popular"],
    priceE8s: "25_000_000",
    summary: "Compact research notes with linked evidence and excerpts.",
    excerpt: "Model evaluation notes with retrieval examples",
    nodes: [
      {
        path: "/Wiki/AI Research.md",
        content: "# AI Research\n\nModel evaluation notes with retrieval examples and [pricing context](/Wiki/Pricing.md)."
      },
      {
        path: "/Wiki/Pricing.md",
        content: "# Pricing\n\nLow price marketplace fixture for decimal max-price checks."
      }
    ]
  },
  {
    name: "Market Seed: Product Playbook",
    title: "Product Launch Playbook",
    description: "Operational launch checklist with buyer onboarding and market examples.",
    tags: ["product", "recent", "playbook"],
    priceE8s: "50_000_000",
    summary: "A launch playbook with docs, checklists, and handoff notes.",
    excerpt: "Operational launch checklist with buyer onboarding",
    nodes: [
      {
        path: "/Wiki/Launch Checklist.md",
        content: "# Launch Checklist\n\nOperational launch checklist with buyer onboarding and [risk review](/Wiki/Risk Review.md)."
      },
      {
        path: "/Wiki/Risk Review.md",
        content: "# Risk Review\n\nRecent listing fixture for sort and filter checks."
      }
    ]
  },
  {
    name: "Market Seed: Knowledge Graph",
    title: "Knowledge Graph Template",
    description: "Graph-oriented wiki seed with category edges and sample excerpts.",
    tags: ["graph", "template", "excerpt"],
    priceE8s: "100_000_000",
    summary: "Template data for graph-heavy marketplace detail screens.",
    excerpt: "Graph-oriented wiki seed with category edges",
    nodes: [
      {
        path: "/Wiki/Graph Template.md",
        content: "# Graph Template\n\nGraph-oriented wiki seed with category edges and [sample nodes](/Wiki/Sample Nodes.md)."
      },
      {
        path: "/Wiki/Sample Nodes.md",
        content: "# Sample Nodes\n\nExcerpt fixture for listing detail density checks."
      }
    ]
  }
];

const options = parseArgs(process.argv.slice(2));
const canister = options.canisterId ?? process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID;
if (!canister) {
  throw new Error("missing --canister-id or NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID");
}
const ledgerCanister = options.ledgerCanisterId ?? process.env.KINIC_LEDGER_CANISTER_ID ?? readWikiLedgerCanisterId();
const payoutPrincipal = options.payoutPrincipal ?? readCurrentPrincipal();
approveCyclesAllowance(ledgerCanister);

for (const fixture of FIXTURES) {
  const created = callOk(
    "create_database",
    candidRecord({ name: candidText(fixture.name) })
  );
  const databaseId = extractTextField(created, "database_id");
  fundDatabase(databaseId);
  callOk("mkdir_node", candidRecord({ database_id: candidText(databaseId), path: candidText("/Wiki") }));
  writeNodes(databaseId, fixture);
  const listing = callOk(
    "market_create_listing",
    candidRecord({
      database_id: candidText(databaseId),
      payout_principal: candidText(payoutPrincipal),
      title: candidText(fixture.title),
      description: candidText(fixture.description),
      llm_summary: `opt ${candidText(fixture.summary)}`,
      tags_json: candidText(JSON.stringify(fixture.tags)),
      price_e8s: `${fixture.priceE8s} : nat64`
    })
  );
  const listingId = extractTextField(listing, "listing_id");
  console.log(`${listingId}\t${databaseId}\t${extractTextField(listing, "title")}\t${extractNat64Field(listing, "price_e8s")}`);
}

function fundDatabase(databaseId) {
  callOk(
    "purchase_database_cycles",
    candidRecord({
      database_id: candidText(databaseId),
      payment_amount_e8s: `${options.paymentE8s} : nat64`,
      min_expected_cycles: `${options.minCycles} : nat64`
    })
  );
}

function readWikiLedgerCanisterId() {
  const config = callOk("get_cycles_billing_config", "");
  return extractTextField(config, "kinic_ledger_canister_id");
}

function readCurrentPrincipal() {
  const result = spawnSync("icp", ["identity", "get-principal"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`identity principal command failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function approveCyclesAllowance(ledgerCanisterId) {
  callOk(
    "icrc2_approve",
    candidRecord({
      spender: `record { owner = principal ${candidText(canister)}; subaccount = null }`,
      amount: `${options.allowanceE8s} : nat`,
      expected_allowance: "null",
      expires_at: "null",
      fee: "null",
      memo: "null",
      from_subaccount: "null",
      created_at_time: "null"
    }),
    ledgerCanisterId
  );
}

function writeNodes(databaseId, fixture) {
  let firstNode = null;
  for (const node of fixture.nodes) {
    const result = callOk(
      "write_node",
      candidRecord({
        database_id: candidText(databaseId),
        path: candidText(node.path),
        kind: "variant { File }",
        content: candidText(node.content),
        metadata_json: candidText("{}"),
        expected_etag: "null"
      })
    );
    const written = {
      path: extractTextField(result, "path"),
      etag: extractTextField(result, "etag")
    };
    if (firstNode === null) {
      firstNode = written;
    }
  }
  if (firstNode === null) {
    throw new Error(`fixture ${fixture.title} did not write nodes`);
  }
  return firstNode;
}

function callOk(method, candidArgs, targetCanister = canister) {
  const response = callCanister(targetCanister, method, candidArgs);
  if (/variant\s*\{\s*Ok\s*=/.test(response.response_candid)) {
    return response.response_candid;
  }
  if (/variant\s*\{\s*Err\s*=/.test(response.response_candid)) {
    const error = extractErr(response.response_candid);
    throw new Error(`${method} failed: ${error}`);
  }
  throw new Error(`${method} returned unexpected response: ${response.response_candid}`);
}

function callCanister(targetCanister, method, candidArgs) {
  const tempDir = mkdtempSync(join(tmpdir(), "kinic-market-seed-"));
  const argsPath = join(tempDir, `${method}.did`);
  try {
    writeFileSync(argsPath, `(${candidArgs})\n`, "utf8");
    const result = spawnSync(
      "icp",
      ["canister", "call", targetCanister, method, "--args-file", argsPath, "-e", options.environment, "--json"],
      { encoding: "utf8" }
    );
    if (result.status !== 0) {
      throw new Error(`${method} command failed\n${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const parsed = {
    environment: "local-wiki",
    paymentE8s: DEFAULT_PAYMENT_E8S,
    minCycles: DEFAULT_MIN_CYCLES,
    allowanceE8s: DEFAULT_ALLOWANCE_E8S
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--canister-id") {
      parsed.canisterId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--environment") {
      parsed.environment = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--payment-e8s") {
      parsed.paymentE8s = normalizeNat64(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--min-cycles") {
      parsed.minCycles = normalizeNat64(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--allowance-e8s") {
      parsed.allowanceE8s = normalizeNat64(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--ledger-canister-id") {
      parsed.ledgerCanisterId = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--payout-principal") {
      parsed.payoutPrincipal = readArgValue(args, index, arg);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function readArgValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function normalizeNat64(value, name) {
  if (!/^\d(?:_?\d)*$/.test(value)) {
    throw new Error(`${name} must be a nat64 decimal literal`);
  }
  return value;
}

function candidRecord(fields) {
  return `record { ${Object.entries(fields).map(([key, value]) => `${key} = ${value}`).join("; ")} }`;
}

function candidText(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n")}"`;
}

function extractTextField(candid, field) {
  const match = new RegExp(`${field} = "([^"]*)"`).exec(candid);
  if (!match) {
    throw new Error(`missing ${field} in response: ${candid}`);
  }
  return match[1];
}

function extractNat64Field(candid, field) {
  const match = new RegExp(`${field} = ([0-9_]+) : nat64`).exec(candid);
  if (!match) {
    throw new Error(`missing ${field} in response: ${candid}`);
  }
  return match[1];
}

function extractErr(candid) {
  const match = /Err = "([\s\S]*)"\s*\}/.exec(candid);
  return match ? match[1].replaceAll("\\\"", "\"") : candid;
}
