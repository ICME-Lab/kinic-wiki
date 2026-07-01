#!/usr/bin/env node
// Where: scripts/bench/wiki-skill-read-strategy.mjs
// What: Deterministically scores wiki skill docs against efficient read-strategy scenarios.
// Why: Skill wording changes need a cheap benchmark before running agent-level empirical tests.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const skillFiles = {
  query: "kinic-wiki-query/query.md",
  lint: "kinic-wiki-lint/lint.md",
  ingest: "kinic-wiki-ingest/ingest.md",
  edit: "kinic-wiki-edit/edit.md",
  contextPack: "kinic-context-pack/context-pack.md"
};

const scenarios = [
  {
    id: "query_answer_read_path",
    title: "Answer a wiki question without full-body candidate fanout",
    skill: "query",
    checks: [
      critical("starts from query_context when available", /query_context[\s\S]{0,120}(normal agent questions|task-scoped context)/i),
      critical("does not answer from search/list alone", /Do not answer from `status`, `list-nodes`, `search-remote`, or `search-path-remote` alone/i),
      critical("uses query-sql by default for two or more known paths", /2 or more known paths[\s\S]{0,120}query-sql/i),
      critical("limits read-node-context to link-aware use", /read-node-context[\s\S]{0,100}only[\s\S]{0,80}link-aware/i),
      critical("keeps read-node to a single final evidence body", /read-node --json[\s\S]{0,120}single final evidence body/i),
      check("uses content-start preview for search", /search-(?:remote|path-remote)[\s\S]{0,80}--preview-mode content-start/i),
      check("uses query-sql for known-path multi-node reads", /query-sql[\s\S]{0,120}known-path multi-node reads/i),
      check("keeps read-node as final evidence fallback", /read-node --json[\s\S]{0,120}(final|evidence|answers)/i)
    ]
  },
  {
    id: "query_broad_cross_source",
    title: "Answer broad conceptual questions across multiple wiki/source nodes",
    skill: "query",
    checks: [
      critical("does not stop at first matching node for broad questions", /Do not stop[\s\S]{0,120}first matching node[\s\S]{0,80}broad questions/i),
      critical("builds multi-node candidate set before synthesis", /Build a multi-node candidate set[\s\S]{0,140}(broad conceptual|corpus synthesis)/i),
      critical("searches Sources when Knowledge is thin", /\/Knowledge[\s\S]{0,120}(thin|sparse|miss)[\s\S]{0,160}\/Sources/i),
      critical("discovers nonstandard prefixes with root inventory", /root (?:prefix )?inventory[\s\S]{0,160}list-nodes --prefix \//i),
      critical("separates title-matched candidates from ability-term candidates", /separate title-matched candidates[\s\S]{0,120}ability-term candidates/i),
      critical("groups evidence by work or source before synthesizing", /Group evidence by work[\s\S]{0,120}source title[\s\S]{0,160}synthesizing/i),
      critical("marks cross-work generalization as inference", /Mark cross-work generalization as inference/i),
      critical("reports coverage limits", /coverage limits[\s\S]{0,120}broad source questions/i),
      check("documents query-sql guardrails", /query-sql` guardrails[\s\S]{0,220}LIMIT[\s\S]{0,120}ORDER BY/i),
      check("uses substr chunks for long rows", /substr\(content[\s\S]{0,120}chunks/i)
    ]
  },
  {
    id: "lint_structure_vs_content",
    title: "Inspect wiki health without reading every node body",
    skill: "lint",
    checks: [
      critical("keeps lint report-only", /Only edit pages if the user asks for fixes/i),
      critical("uses list-nodes/link commands for content-free structure checks", /list-nodes[\s\S]{0,160}structure checks that do not need content/i),
      critical("uses query-sql by default for two or more known paths", /2 or more known paths[\s\S]{0,120}query-sql/i),
      critical("limits read-node-context to link-aware use", /read-node-context[\s\S]{0,140}(catalog|navigation|link-aware)[\s\S]{0,120}ordinary body reads or structure inventory/i),
      critical("keeps read-node to one final offending node", /read-node[\s\S]{0,120}one final offending node/i),
      check("uses content-start preview before full reads", /--preview-mode content-start/i),
      check("uses query-sql for canonicality across several notes", /query-sql[\s\S]{0,140}canonicality/i),
      check("documents Store API scope reads as tool-only", /export_snapshot[\s\S]{0,100}not a normal CLI command/i)
    ]
  },
  {
    id: "ingest_bulk_context",
    title: "Prepare ingest write set without looping read-node",
    skill: "ingest",
    checks: [
      critical("keeps write-nodes as bulk write primitive", /Bulk writes: CLI `write-nodes --input <nodes\.json>`/i),
      critical("uses query_context for source/wiki context collection", /query_context[\s\S]{0,120}source\/wiki context collection/i),
      critical("uses query-sql by default for two or more known paths", /2 or more (?:known paths|existing nodes)[\s\S]{0,120}query-sql/i),
      critical("limits read-node-context to link-aware catalog context", /read-node-context[\s\S]{0,140}link-aware catalog\/navigation context/i),
      critical("keeps read-node to a single mutation-adjacent check", /read-node[\s\S]{0,120}single mutation-adjacent final check/i),
      check("uses list-nodes for overwrite inventory", /list-nodes[\s\S]{0,120}(overwrite etags|inventory)/i),
      check("uses query-sql or export_snapshot for scoped checks", /query-sql[\s\S]{0,80}export_snapshot|export_snapshot[\s\S]{0,80}query-sql/i),
      check("keeps DB metadata explicit approval", /Metadata refresh needs a user-visible candidate and explicit approval/i)
    ]
  },
  {
    id: "edit_safe_multi_node_repair",
    title: "Repair multiple nodes efficiently while preserving etag safety",
    skill: "edit",
    checks: [
      critical("re-reads accepted nodes immediately before mutation", /re-read each accepted node[\s\S]{0,120}immediately before mutation/i),
      critical("uses expected-etag protected edit commands", /expected-etag` protects against concurrent writes/i),
      critical("uses query-sql by default for two or more known paths", /2 or more known paths[\s\S]{0,120}query-sql/i),
      critical("limits read-node-context to link-aware repair planning", /read-node-context[\s\S]{0,140}link-aware repair planning/i),
      critical("keeps read-node mandatory only for mutation safety", /read-node[\s\S]{0,120}mandatory immediately before each write/i),
      check("narrows candidates before full reads", /list-nodes`, search preview, or `query-sql`[\s\S]{0,120}before full reads/i),
      check("uses query-sql for false-positive checks", /query-sql[\s\S]{0,120}false positives/i),
      check("keeps multi-edit-node scoped to one node", /multi-edit-node` is not a multi-node batch command/i)
    ]
  },
  {
    id: "context_pack_handoff",
    title: "Export handoff context without ad hoc node loops",
    skill: "contextPack",
    checks: [
      critical("uses context-pack export as preferred read path", /context-pack export` is the preferred read path/i),
      critical("does not pre-read scope with read-node loops", /Do not pre-read the scope with ad hoc `read-node` loops/i),
      check("states query_context is internal to export", /uses `query_context` internally/i),
      check("uses inspect for local bundle summaries", /context-pack inspect` for local bundle summaries/i),
      check("keeps raw scope/delta reads tool-only", /export_snapshot[\s\S]{0,120}fetch_updates[\s\S]{0,120}Store API\/tool access/i),
      check("keeps raw scope/delta benchmarks separate from export", /Measure those raw reads with the Store API latency benchmark/i)
    ]
  }
];

const { targets, json } = parseArgs(process.argv.slice(2));
const reports = targets.map(runBenchmark);

if (json) {
  console.log(JSON.stringify({ reports }, null, 2));
} else {
  printTextReport(reports);
}

const failed = reports.some((report) => report.failedCritical > 0);
if (failed) {
  process.exitCode = 1;
}

function runBenchmark(target) {
  const docs = loadDocs(target.path);
  const results = scenarios.map((scenario) => scoreScenario(scenario, docs[scenario.skill]));
  const points = results.reduce((sum, result) => sum + result.points, 0);
  const maxPoints = results.reduce((sum, result) => sum + result.maxPoints, 0);
  const failedCritical = results.reduce((sum, result) => sum + result.failedCritical.length, 0);
  return {
    label: target.label,
    path: target.path,
    points,
    maxPoints,
    score: Math.round((points / maxPoints) * 100),
    failedCritical,
    results
  };
}

function loadDocs(skillsDir) {
  const docs = {};
  for (const [key, relativePath] of Object.entries(skillFiles)) {
    const path = join(skillsDir, relativePath);
    assert.ok(existsSync(path), `missing skill workflow: ${path}`);
    docs[key] = readFileSync(path, "utf8");
  }
  return docs;
}

function scoreScenario(scenario, content) {
  const outcomes = scenario.checks.map((item) => {
    const passed = item.pattern.test(content);
    return {
      label: item.label,
      critical: item.critical,
      passed
    };
  });
  const points = outcomes.filter((item) => item.passed).length;
  const failedCritical = outcomes.filter((item) => item.critical && !item.passed).map((item) => item.label);
  return {
    id: scenario.id,
    title: scenario.title,
    skill: scenario.skill,
    points,
    maxPoints: outcomes.length,
    score: Math.round((points / outcomes.length) * 100),
    failedCritical,
    outcomes
  };
}

function parseArgs(args) {
  const targets = [];
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--skills-dir") {
      const value = args[index + 1];
      assert.ok(value, "--skills-dir requires a value");
      targets.push(parseTarget(value));
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (targets.length === 0) {
    targets.push({ label: "repo", path: join(root, "skills") });
  }
  return { targets, json };
}

function parseTarget(value) {
  const separator = value.indexOf("=");
  if (separator === -1) {
    return { label: value, path: resolve(value) };
  }
  const label = value.slice(0, separator);
  const path = value.slice(separator + 1);
  assert.ok(label, "--skills-dir label must not be empty");
  assert.ok(path, "--skills-dir path must not be empty");
  return { label, path: resolve(path) };
}

function printTextReport(reports) {
  for (const report of reports) {
    console.log(`\n${report.label}: ${report.score}% (${report.points}/${report.maxPoints})`);
    for (const result of report.results) {
      const marker = result.failedCritical.length ? "FAIL" : "OK";
      console.log(`  [${marker}] ${result.id}: ${result.score}% (${result.points}/${result.maxPoints})`);
      for (const outcome of result.outcomes) {
        const status = outcome.passed ? "PASS" : "FAIL";
        const critical = outcome.critical ? " critical" : "";
        console.log(`    ${status}${critical} ${outcome.label}`);
      }
      for (const failure of result.failedCritical) {
        console.log(`    critical failure: ${failure}`);
      }
    }
  }
}

function printHelp() {
  console.log(`Usage:
  node scripts/bench/wiki-skill-read-strategy.mjs
  node scripts/bench/wiki-skill-read-strategy.mjs --json
  node scripts/bench/wiki-skill-read-strategy.mjs --skills-dir current=skills --skills-dir candidate=/tmp/skills
`);
}

function critical(label, pattern) {
  return { label, pattern, critical: true };
}

function check(label, pattern) {
  return { label, pattern, critical: false };
}
