#!/usr/bin/env node
// Where: scripts/bench/wiki-skill-command-latency.mjs
// What: Measures read-only wiki CLI command latency against a public mainnet database.
// Why: Skill read strategies should be checked against actual command costs, not text coverage only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_CANISTER_ID = "6emaw-iyaaa-aaaay-aacka-cai";
const DEFAULT_DB_TITLE = "KINIC-WIKI";
const DEFAULT_QUERY = "vfs cli";
const DEFAULT_PATH_QUERY = "repo-docs-cli";
const DEFAULT_PREFIX = "/Sources";
const DEFAULT_ITERATIONS = 5;
const DEFAULT_WARMUP = 1;

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  const failure = {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
  emitReport(failure, args.outputJson);
  process.exitCode = 1;
});

async function main() {
  const startedAt = new Date().toISOString();
  if (!existsSync(args.cliBin)) {
    throw new Error(`CLI binary not found: ${args.cliBin}. Run cargo build -p kinic-vfs-cli --bin kinic-vfs-cli --bin vfs_bench first or pass --cli-bin <path>.`);
  }
  const databaseId = args.databaseId ?? (await selectDatabaseId());
  const setup = await discoverScenarioInputs(databaseId);
  const scenarios = buildScenarios(databaseId, setup);
  const results = [];

  for (const scenario of scenarios) {
    const result = await measureScenario(scenario);
    results.push(result);
  }

  const report = {
    ok: results.every((result) => result.ok),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    canister_id: args.canisterId,
    database_id: databaseId,
    database_title: args.databaseTitle,
    query: args.query,
    path_query: args.pathQuery,
    prefix: args.prefix,
    iterations: args.iterations,
    warmup: args.warmup,
    setup,
    results,
    comparisons: compareResults(results)
  };
  emitReport(report, args.outputJson);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function selectDatabaseId() {
  const command = cliArgs(["database", "list", "--json"]);
  const result = await runCommand(command);
  if (result.exit_code !== 0) {
    throw new Error(`database list failed: ${result.stderr.trim()}`);
  }
  const databases = parseJson(result.stdout, "database list");
  assert.ok(Array.isArray(databases), "database list JSON must be an array");
  const expected = args.databaseTitle.toLowerCase();
  const found = databases.find((database) => {
    const metadata = database.metadata ?? {};
    const name = String(metadata.name ?? "").toLowerCase();
    const description = String(metadata.description ?? "").toLowerCase();
    const tags = String(metadata.tags_json ?? "").toLowerCase();
    return name === expected || name.includes(expected) || description.includes(expected) || tags.includes(expected);
  });
  if (!found) {
    throw new Error(`public database not found by title/tag: ${args.databaseTitle}`);
  }
  return String(found.database_id);
}

async function discoverScenarioInputs(databaseId) {
  const search = await runCommand(cliArgs([
    "--database-id",
    databaseId,
    "search-remote",
    args.query,
    "--prefix",
    args.prefix,
    "--top-k",
    "10",
    "--preview-mode",
    "content-start",
    "--json"
  ]));
  const paths = [];
  if (search.exit_code === 0) {
    for (const hit of safeArrayJson(search.stdout)) {
      if (typeof hit.path === "string" && hit.path.startsWith(args.prefix)) {
        paths.push(hit.path);
      }
    }
  }

  if (paths.length < 2) {
    const inventory = await runCommand(cliArgs([
      "--database-id",
      databaseId,
      "query-sql",
      `SELECT json_object('path', path) FROM fs_nodes WHERE kind != 'folder' ORDER BY path ASC LIMIT 10`,
      "--limit",
      "10",
      "--json"
    ]));
    if (inventory.exit_code === 0) {
      for (const row of querySqlRows(inventory.stdout)) {
        if (typeof row.path === "string" && row.path.startsWith(args.prefix)) {
          paths.push(row.path);
        }
      }
    }
  }

  const uniquePaths = [...new Set(paths)].slice(0, 5);
  if (uniquePaths.length === 0) {
    throw new Error(`no readable node path found under prefix: ${args.prefix}`);
  }
  const primaryPath = uniquePaths[0];
  const multiPaths = uniquePaths.slice(0, Math.max(2, Math.min(uniquePaths.length, 3)));
  if (multiPaths.length === 0) {
    multiPaths.push(primaryPath);
  }
  return {
    primary_path: primaryPath,
    multi_paths: multiPaths,
    discovery_search_exit_code: search.exit_code
  };
}

function buildScenarios(databaseId, setup) {
  const multiPathSqlList = setup.multi_paths.map(sqlString).join(",");
  return [
    scenario("status", cliArgs(["--database-id", databaseId, "status", "--json"])),
    scenario("search_remote_light", cliArgs([
      "--database-id",
      databaseId,
      "search-remote",
      args.query,
      "--prefix",
      args.prefix,
      "--top-k",
      "10",
      "--json"
    ])),
    scenario("search_remote_content_start", cliArgs([
      "--database-id",
      databaseId,
      "search-remote",
      args.query,
      "--prefix",
      args.prefix,
      "--top-k",
      "10",
      "--preview-mode",
      "content-start",
      "--json"
    ])),
    scenario("search_path_none", cliArgs([
      "--database-id",
      databaseId,
      "search-path-remote",
      args.pathQuery,
      "--prefix",
      args.prefix,
      "--top-k",
      "10",
      "--json"
    ])),
    scenario("search_path_content_start", cliArgs([
      "--database-id",
      databaseId,
      "search-path-remote",
      args.pathQuery,
      "--prefix",
      args.prefix,
      "--top-k",
      "10",
      "--preview-mode",
      "content-start",
      "--json"
    ])),
    scenario("list_nodes_recursive", cliArgs([
      "--database-id",
      databaseId,
      "list-nodes",
      "--prefix",
      args.prefix,
      "--recursive",
      "--json"
    ])),
    scenario("read_node_primary", cliArgs([
      "--database-id",
      databaseId,
      "read-node",
      "--path",
      setup.primary_path,
      "--json"
    ])),
    scenario("read_node_context_primary", cliArgs([
      "--database-id",
      databaseId,
      "read-node-context",
      "--path",
      setup.primary_path,
      "--link-limit",
      "20",
      "--json"
    ])),
    scenario("query_sql_metadata", cliArgs([
      "--database-id",
      databaseId,
      "query-sql",
      "SELECT json_object('path', path, 'kind', kind, 'etag', etag, 'metadata_json', metadata_json) FROM fs_nodes ORDER BY path ASC LIMIT 20",
      "--limit",
      "20",
      "--json"
    ])),
    scenario("query_sql_content", cliArgs([
      "--database-id",
      databaseId,
      "query-sql",
      `SELECT json_object('path', path, 'kind', kind, 'etag', etag, 'metadata_json', metadata_json, 'content', content) FROM fs_nodes WHERE path IN (${multiPathSqlList}) LIMIT ${setup.multi_paths.length}`,
      "--limit",
      String(setup.multi_paths.length),
      "--json"
    ])),
    ...setup.multi_paths.map((path, index) =>
      scenario(`read_node_multi_${index + 1}`, cliArgs([
        "--database-id",
        databaseId,
        "read-node",
        "--path",
        path,
        "--json"
      ]))
    )
  ];
}

function scenario(name, command) {
  assertReadOnly(command);
  return { name, command };
}

async function measureScenario(item) {
  const warmups = [];
  for (let index = 0; index < args.warmup; index += 1) {
    warmups.push(await runCommand(item.command));
  }
  const samples = [];
  for (let index = 0; index < args.iterations; index += 1) {
    samples.push(await runCommand(item.command));
  }
  const durations = samples.map((sample) => sample.duration_ms);
  const stdoutBytes = samples.map((sample) => sample.stdout_bytes);
  const ok = samples.every((sample) => sample.exit_code === 0);
  return {
    name: item.name,
    command: item.command,
    ok,
    warmup_exit_codes: warmups.map((sample) => sample.exit_code),
    exit_codes: samples.map((sample) => sample.exit_code),
    latency_ms: stats(durations),
    stdout_bytes: stats(stdoutBytes),
    last_error: ok ? null : samples.find((sample) => sample.exit_code !== 0)?.stderr.slice(0, 2000) ?? null
  };
}

function compareResults(results) {
  const byName = Object.fromEntries(results.map((result) => [result.name, result]));
  const comparisons = [];
  addRatio(comparisons, byName, "search_remote_content_start", "search_remote_light", "content-start vs light content search");
  addRatio(comparisons, byName, "search_path_content_start", "search_path_none", "content-start vs no-preview path search");
  const readMulti = results.filter((result) => result.name.startsWith("read_node_multi_"));
  const queryContent = byName.query_sql_content;
  if (queryContent && readMulti.length > 0) {
    const readTotalAvg = readMulti.reduce((sum, result) => sum + result.latency_ms.avg, 0);
    comparisons.push({
      label: "query-sql content vs sum(read-node multi)",
      left: "query_sql_content",
      right: "sum(read_node_multi_*)",
      left_avg_ms: queryContent.latency_ms.avg,
      right_avg_ms: readTotalAvg,
      ratio: queryContent.latency_ms.avg / readTotalAvg
    });
  }
  return comparisons;
}

function addRatio(comparisons, byName, leftName, rightName, label) {
  const left = byName[leftName];
  const right = byName[rightName];
  if (!left || !right || right.latency_ms.avg === 0) {
    return;
  }
  comparisons.push({
    label,
    left: leftName,
    right: rightName,
    left_avg_ms: left.latency_ms.avg,
    right_avg_ms: right.latency_ms.avg,
    ratio: left.latency_ms.avg / right.latency_ms.avg
  });
}

function cliArgs(rest) {
  return [
    args.cliBin,
    "--canister-id",
    args.canisterId,
    "--identity-mode",
    "anonymous",
    ...rest
  ];
}

function runCommand(command) {
  return new Promise((resolveResult) => {
    const started = process.hrtime.bigint();
    const child = spawn(command[0], command.slice(1), {
      cwd: args.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      const duration = elapsedMs(started);
      resolveResult({
        exit_code: -1,
        duration_ms: duration,
        stdout: "",
        stderr: error.message,
        stdout_bytes: 0,
        stderr_bytes: Buffer.byteLength(error.message)
      });
    });
    child.on("close", (code) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      resolveResult({
        exit_code: code ?? -1,
        duration_ms: elapsedMs(started),
        stdout: stdoutText,
        stderr: stderrText,
        stdout_bytes: Buffer.byteLength(stdoutText),
        stderr_bytes: Buffer.byteLength(stderrText)
      });
    });
  });
}

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const count = sorted.length;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count,
    avg: count === 0 ? 0 : total / count,
    min: count === 0 ? 0 : sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: count === 0 ? 0 : sorted[count - 1]
  };
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.floor((percentileValue / 100) * (sortedValues.length - 1));
  return sortedValues[index];
}

function elapsedMs(started) {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function safeArrayJson(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function querySqlRows(text) {
  const parsed = parseJson(text, "query-sql");
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  return rows.map((row) => parseJson(row, "query-sql row"));
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assertReadOnly(command) {
  const blocked = new Set([
    "write-node",
    "write-nodes",
    "append-node",
    "edit-node",
    "multi-edit-node",
    "delete-node",
    "delete-tree",
    "move-node",
    "mkdir-node",
    "rebuild-index",
    "rebuild-scope-index",
    "database metadata",
    "database grant",
    "database create",
    "database purchase-cycles"
  ]);
  const joined = command.join(" ");
  for (const token of blocked) {
    assert.ok(!joined.includes(token), `latency benchmark command is not read-only: ${joined}`);
  }
}

function parseArgs(argv) {
  const parsed = {
    canisterId: DEFAULT_CANISTER_ID,
    databaseTitle: DEFAULT_DB_TITLE,
    databaseId: null,
    query: DEFAULT_QUERY,
    pathQuery: DEFAULT_PATH_QUERY,
    prefix: DEFAULT_PREFIX,
    iterations: DEFAULT_ITERATIONS,
    warmup: DEFAULT_WARMUP,
    outputJson: null,
    cwd: process.cwd(),
    cliBin: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--canister-id") {
      parsed.canisterId = requiredValue(argv, ++index, arg);
    } else if (arg === "--database-id") {
      parsed.databaseId = requiredValue(argv, ++index, arg);
    } else if (arg === "--database-title") {
      parsed.databaseTitle = requiredValue(argv, ++index, arg);
    } else if (arg === "--query") {
      parsed.query = requiredValue(argv, ++index, arg);
    } else if (arg === "--path-query") {
      parsed.pathQuery = requiredValue(argv, ++index, arg);
    } else if (arg === "--prefix") {
      parsed.prefix = requiredValue(argv, ++index, arg);
    } else if (arg === "--iterations") {
      parsed.iterations = parsePositiveInteger(requiredValue(argv, ++index, arg), arg);
    } else if (arg === "--warmup") {
      parsed.warmup = parseNonNegativeInteger(requiredValue(argv, ++index, arg), arg);
    } else if (arg === "--output-json") {
      parsed.outputJson = requiredValue(argv, ++index, arg);
    } else if (arg === "--cwd") {
      parsed.cwd = requiredValue(argv, ++index, arg);
    } else if (arg === "--cli-bin") {
      parsed.cliBin = requiredValue(argv, ++index, arg);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  parsed.cliBin = resolve(parsed.cwd, parsed.cliBin ?? "target/debug/kinic-vfs-cli");
  return parsed;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function emitReport(report, outputJson) {
  const text = JSON.stringify(report, null, 2);
  if (outputJson) {
    writeFileSync(outputJson, `${text}\n`);
  }
  console.log(text);
}

function printHelp() {
  console.log(`Usage:
  node scripts/bench/wiki-skill-command-latency.mjs
  node scripts/bench/wiki-skill-command-latency.mjs --cli-bin target/debug/kinic-vfs-cli
  node scripts/bench/wiki-skill-command-latency.mjs --database-id <db> --iterations 5 --warmup 1
  node scripts/bench/wiki-skill-command-latency.mjs --prefix /Sources --query "vfs cli"
  node scripts/bench/wiki-skill-command-latency.mjs --output-json /tmp/wiki-latency.json
`);
}
