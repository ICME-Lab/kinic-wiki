#!/usr/bin/env node
// Where: scripts/bench/wiki-mcp-latency.mjs
// What: Measures read-only Kinic Wiki remote MCP tool latency over Streamable HTTP JSON-RPC.
// Why: MCP read strategy changes should be checked against actual tool-call costs.
import { writeFileSync } from "node:fs";

const DEFAULT_MCP_URL = "http://127.0.0.1:8787/mcp";
const DEFAULT_DATABASE_QUERY = "KINIC-WIKI";
const DEFAULT_QUERY = "vfs cli";
const DEFAULT_PREFIX = "/Knowledge";
const DEFAULT_ITERATIONS = 5;
const DEFAULT_WARMUP = 1;

const args = parseArgs(process.argv.slice(2));
let jsonRpcId = 0;
let activeMcpUrl = args.mcpUrl;

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
  const urls = [args.mcpUrl, ...args.compareUrls];
  if (urls.length > 1) {
    const baseline = await runBenchmark(args.mcpUrl);
    const reports = [baseline];
    for (const url of args.compareUrls) {
      reports.push(
        await runBenchmark(url, {
          databaseId: baseline.database_id,
          setup: baseline.setup,
          setupSourceMcpUrl: baseline.mcp_url
        })
      );
    }
    const report = {
      ok: reports.every((item) => item.ok),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      baseline_mcp_url: args.mcpUrl,
      compare_urls: args.compareUrls,
      reports,
      cross_endpoint_comparisons: compareReports(reports)
    };
    emitReport(report, args.outputJson);
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  const report = await runBenchmark(args.mcpUrl, { startedAt });
  emitReport(report, args.outputJson);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function runBenchmark(mcpUrl, options = {}) {
  const startedAt = options.startedAt ?? new Date().toISOString();
  activeMcpUrl = mcpUrl;
  jsonRpcId = 0;
  const toolsList = await mcpRequest("tools/list", {});
  const tools = Array.isArray(toolsList.result?.tools) ? toolsList.result.tools : [];
  const capabilities = toolCapabilities(tools);
  const toolNames = tools.map((tool) => tool.name).sort();
  const databaseId = options.databaseId ?? args.databaseId ?? (await selectDatabaseId());
  const setup = options.setup ?? (await discoverScenarioInputs(databaseId, capabilities));
  const scenarios = buildScenarios(databaseId, setup, capabilities);
  const results = [];

  for (const scenario of scenarios) {
    results.push(await measureScenario(scenario));
  }

  const report = {
    ok: results.every((result) => result.ok),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    mcp_url: mcpUrl,
    tool_names: toolNames,
    capabilities: {
      tool_names: [...capabilities.tools].sort(),
      search_preview_mode: capabilities.search_preview_mode
    },
    database_id: databaseId,
    database_query: args.databaseQuery,
    query: args.query,
    prefix: args.prefix,
    iterations: args.iterations,
    warmup: args.warmup,
    setup,
    setup_source_mcp_url: options.setupSourceMcpUrl ?? mcpUrl,
    results,
    comparisons: compareResults(results)
  };
  return report;
}

async function selectDatabaseId() {
  const result = await callTool("find_databases", { query: args.databaseQuery, limit: 10 });
  const databases = result.payload?.databases;
  if (!Array.isArray(databases) || databases.length === 0) {
    throw new Error(`find_databases returned no candidates for query: ${args.databaseQuery}`);
  }
  return String(databases[0].database_id);
}

async function discoverScenarioInputs(databaseId, capabilities) {
  const search = await callTool("search", compactObject({
    database_id: databaseId,
    query: args.query,
    prefix: args.prefix,
    limit: 10,
    preview_mode: capabilities.search_preview_mode ? "content-start" : undefined
  }));
  const results = Array.isArray(search.payload?.results) ? search.payload.results : [];
  const ids = results.map((item) => item.id).filter((value) => typeof value === "string").slice(0, 3);
  const paths = results
    .map((item) => item.metadata?.path)
    .filter((value) => typeof value === "string")
    .slice(0, 3);

  if (ids.length === 0 || paths.length === 0) {
    throw new Error(`search returned no fetchable results for database=${databaseId} query=${args.query}`);
  }

  return {
    primary_id: ids[0],
    primary_path: paths[0],
    fetch_ids: ids,
    paths,
    discovery_result_count: results.length
  };
}

function buildScenarios(databaseId, setup, capabilities) {
  const scenarios = [
    scenario("tools_list", () => mcpRequest("tools/list", {})),
    scenario("find_databases", () => callTool("find_databases", { query: args.databaseQuery, limit: 10 })),
    capabilities.tools.has("context") ? scenario("context", () =>
      callTool("context", {
        database_id: databaseId,
        task: args.query,
        namespace: args.prefix,
        budget_tokens: 2000,
        include_evidence: true,
        depth: 1
      })
    ) : null,
    scenario("search_light", () =>
      callTool("search", compactObject({
        database_id: databaseId,
        query: args.query,
        prefix: args.prefix,
        limit: 10,
        preview_mode: capabilities.search_preview_mode ? "light" : undefined
      }))
    ),
    capabilities.search_preview_mode ? scenario("search_content_start", () =>
      callTool("search", {
        database_id: databaseId,
        query: args.query,
        prefix: args.prefix,
        limit: 10,
        preview_mode: "content-start"
      })
    ) : null,
    capabilities.tools.has("list") ? scenario("list_root_shallow", () => callTool("list", { database_id: databaseId, prefix: "/", recursive: false, limit: 100 })) : null,
    capabilities.tools.has("list") ? scenario("list_prefix_recursive", () => callTool("list", { database_id: databaseId, prefix: args.prefix, recursive: true, limit: 100 })) : null,
    scenario("fetch_one", () => callTool("fetch", { id: setup.primary_id })),
    capabilities.tools.has("fetch_many") ? scenario("fetch_many", () => callTool("fetch_many", { ids: setup.fetch_ids })) : null,
    capabilities.tools.has("read_path") ? scenario("read_path", () => callTool("read_path", { database_id: databaseId, path: setup.primary_path })) : null,
    capabilities.tools.has("read_paths") ? scenario("read_paths", () => callTool("read_paths", { database_id: databaseId, paths: setup.paths })) : null,
    scenario("fetch_one_sequential_same_count", async () => {
      const started = performance.now();
      const calls = [];
      for (const id of setup.fetch_ids) {
        calls.push(await callTool("fetch", { id }));
      }
      const elapsedMs = performance.now() - started;
      return {
        ok: calls.every((call) => call.ok),
        http_status: 200,
        bytes: calls.reduce((sum, call) => sum + call.bytes, 0),
        elapsed_ms_override: elapsedMs,
        payload: { calls: calls.length }
      };
    })
  ];
  return scenarios.filter(Boolean);
}

function scenario(name, run) {
  return { name, run };
}

async function measureScenario(item) {
  const samples = [];
  const totalRuns = args.warmup + args.iterations;
  for (let index = 0; index < totalRuns; index += 1) {
    const warmup = index < args.warmup;
    const sample = await measureCall(item.run);
    if (!warmup) {
      samples.push(sample);
    }
  }
  const latencies = samples.map((sample) => sample.latency_ms);
  const ok = samples.every((sample) => sample.ok);
  const bytes = samples.map((sample) => sample.bytes);
  return {
    name: item.name,
    ok,
    runs: samples.length,
    latency_ms: stats(latencies),
    response_bytes: stats(bytes),
    payload_metrics: summarizePayloadMetrics(samples.map((sample) => sample.payload_metrics)),
    exit_codes: [...new Set(samples.map((sample) => sample.http_status))],
    errors: samples.flatMap((sample) => sample.error ? [sample.error] : []).slice(0, 3)
  };
}

async function measureCall(run) {
  const started = performance.now();
  try {
    const result = await run();
    const elapsed = result.elapsed_ms_override ?? performance.now() - started;
    return {
      ok: result.ok,
      http_status: result.http_status,
      bytes: result.bytes,
      latency_ms: elapsed,
      error: result.error,
      payload_metrics: payloadMetrics(result.payload)
    };
  } catch (error) {
    return {
      ok: false,
      http_status: 0,
      bytes: 0,
      latency_ms: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
      payload_metrics: null
    };
  }
}

async function callTool(name, toolArgs) {
  const response = await mcpRequest("tools/call", { name, arguments: toolArgs });
  const content = response.result?.content;
  const text = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
  return {
    ...response,
    payload: safeJson(text),
    ok: response.ok && response.result?.isError !== true
  };
}

async function mcpRequest(method, params) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: nextJsonRpcId(),
    method,
    params
  });
  const started = performance.now();
  const response = await fetch(activeMcpUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18"
    },
    body
  });
  const text = await response.text();
  const data = parseMcpResponse(text);
  const ok = response.ok && !data.error;
  return {
    ok,
    http_status: response.status,
    bytes: Buffer.byteLength(text),
    latency_ms: performance.now() - started,
    result: data.result,
    error: data.error ? JSON.stringify(data.error) : undefined
  };
}

function nextJsonRpcId() {
  jsonRpcId += 1;
  return jsonRpcId;
}

function parseMcpResponse(text) {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (dataLine) {
    return JSON.parse(dataLine.slice("data: ".length));
  }
  return JSON.parse(text);
}

function stats(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    avg: round(sum / sorted.length),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1])
  };
}

function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}

function compareResults(results) {
  const byName = Object.fromEntries(results.map((result) => [result.name, result]));
  return {
    fetch_many_vs_sequential_fetch_avg_ratio: ratio(byName.fetch_many, byName.fetch_one_sequential_same_count),
    read_paths_vs_fetch_many_avg_ratio: ratio(byName.read_paths, byName.fetch_many),
    read_paths_vs_sequential_fetch_avg_ratio: ratio(byName.read_paths, byName.fetch_one_sequential_same_count),
    context_vs_search_content_start_avg_ratio: ratio(byName.context, byName.search_content_start),
    read_path_vs_fetch_one_avg_ratio: ratio(byName.read_path, byName.fetch_one)
  };
}

function compareReports(reports) {
  const [baseline, ...targets] = reports;
  if (!baseline) {
    return [];
  }
  const baselineResults = resultsByName(baseline);
  const baselineTools = new Set(baseline.tool_names ?? []);
  return targets.map((target) => {
    const targetResults = resultsByName(target);
    const targetTools = new Set(target.tool_names ?? []);
    const scenarioNames = [...new Set([...baselineResults.keys(), ...targetResults.keys()])].sort();
    const latencyAvgRatioByScenario = {};
    const payloadMetricDiffs = {};
    for (const name of scenarioNames) {
      latencyAvgRatioByScenario[name] = ratio(targetResults.get(name), baselineResults.get(name));
      const metricDiff = comparePayloadMetricSummaries(targetResults.get(name)?.payload_metrics, baselineResults.get(name)?.payload_metrics);
      if (metricDiff) {
        payloadMetricDiffs[name] = metricDiff;
      }
    }
    return {
      baseline_mcp_url: baseline.mcp_url,
      target_mcp_url: target.mcp_url,
      target_vs_baseline_latency_avg_ratio_by_scenario: latencyAvgRatioByScenario,
      target_vs_baseline_payload_metric_avg_diff_by_scenario: payloadMetricDiffs,
      only_in_baseline_tools: [...baselineTools].filter((name) => !targetTools.has(name)).sort(),
      only_in_target_tools: [...targetTools].filter((name) => !baselineTools.has(name)).sort()
    };
  });
}

function resultsByName(report) {
  return new Map((report.results ?? []).map((result) => [result.name, result]));
}

function comparePayloadMetricSummaries(target, baseline) {
  if (!isRecord(target) || !isRecord(baseline)) {
    return null;
  }
  const keys = [...new Set([...Object.keys(target), ...Object.keys(baseline)])].sort();
  const diff = {};
  for (const key of keys) {
    const targetAvg = isRecord(target[key]) && typeof target[key].avg === "number" ? target[key].avg : null;
    const baselineAvg = isRecord(baseline[key]) && typeof baseline[key].avg === "number" ? baseline[key].avg : null;
    if (targetAvg !== null && baselineAvg !== null) {
      diff[key] = round(targetAvg - baselineAvg);
    }
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

function payloadMetrics(payload) {
  if (!isRecord(payload)) {
    return null;
  }
  const metrics = {};
  if (Array.isArray(payload.databases)) {
    metrics.database_count = payload.databases.length;
  }
  if (Array.isArray(payload.results)) {
    metrics.result_count = payload.results.length;
    metrics.item_error_count = payload.results.filter((item) => isRecord(item) && item.is_error === true).length;
    const textChars = payload.results.reduce((sum, item) => sum + textLength(isRecord(item) ? item.text : null), 0);
    const previewChars = payload.results.reduce((sum, item) => {
      if (!isRecord(item) || !isRecord(item.metadata)) {
        return sum;
      }
      return sum + textLength(item.metadata.preview);
    }, 0);
    const truncatedValues = payload.results.filter((item) => isRecord(item) && isRecord(item.metadata) && typeof item.metadata.truncated === "boolean");
    if (textChars > 0) {
      metrics.text_chars = textChars;
    }
    if (previewChars > 0) {
      metrics.preview_chars = previewChars;
      metrics.preview_count = payload.results.filter((item) => isRecord(item) && isRecord(item.metadata) && textLength(item.metadata.preview) > 0).length;
    }
    if (truncatedValues.length > 0) {
      metrics.truncated_count = truncatedValues.filter((item) => isRecord(item) && isRecord(item.metadata) && item.metadata.truncated === true).length;
    }
  }
  if (Array.isArray(payload.entries)) {
    metrics.entry_count = payload.entries.length;
  }
  if (Array.isArray(payload.nodes)) {
    metrics.node_count = payload.nodes.length;
    metrics.node_text_chars = payload.nodes.reduce((sum, item) => {
      if (!isRecord(item) || !isRecord(item.node)) {
        return sum;
      }
      return sum + textLength(item.node.text);
    }, 0);
    metrics.node_truncated_count = payload.nodes.filter((item) => isRecord(item) && isRecord(item.node) && item.node.truncated === true).length;
  }
  if (Array.isArray(payload.evidence)) {
    metrics.evidence_count = payload.evidence.length;
    metrics.evidence_ref_count = payload.evidence.reduce((sum, item) => {
      if (!isRecord(item) || !Array.isArray(item.refs)) {
        return sum;
      }
      return sum + item.refs.length;
    }, 0);
  }
  if (Array.isArray(payload.search_hits)) {
    metrics.search_hit_count = payload.search_hits.length;
  }
  if (Array.isArray(payload.graph_links)) {
    metrics.graph_link_count = payload.graph_links.length;
  }
  if (typeof payload.text === "string") {
    metrics.text_chars = payload.text.length;
  }
  if (isRecord(payload.metadata) && typeof payload.metadata.truncated === "boolean") {
    metrics.truncated = payload.metadata.truncated;
  } else if (typeof payload.truncated === "boolean") {
    metrics.truncated = payload.truncated;
  }
  return Object.keys(metrics).length > 0 ? metrics : null;
}

function summarizePayloadMetrics(samples) {
  const metrics = samples.filter(isRecord);
  if (metrics.length === 0) {
    return null;
  }
  const keys = [...new Set(metrics.flatMap((metric) => Object.keys(metric)))].sort();
  const summary = {};
  for (const key of keys) {
    const values = metrics.map((metric) => metric[key]).filter((value) => typeof value === "number" || typeof value === "boolean");
    if (values.length === 0) {
      continue;
    }
    if (values.every((value) => typeof value === "number")) {
      summary[key] = stats(values);
    } else if (values.every((value) => typeof value === "boolean")) {
      summary[key] = {
        values: [...new Set(values)].sort(),
        true_count: values.filter(Boolean).length,
        false_count: values.filter((value) => !value).length
      };
    }
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function toolCapabilities(tools) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const searchProperties = byName.get("search")?.inputSchema?.properties ?? {};
  return {
    tools: new Set(byName.keys()),
    search_preview_mode: Boolean(searchProperties.preview_mode)
  };
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function ratio(left, right) {
  if (!left?.latency_ms?.avg || !right?.latency_ms?.avg) {
    return null;
  }
  return round(left.latency_ms.avg / right.latency_ms.avg);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function textLength(value) {
  return typeof value === "string" ? value.length : 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitReport(report, outputJson) {
  const text = JSON.stringify(report, null, 2);
  if (outputJson) {
    writeFileSync(outputJson, `${text}\n`);
  }
  console.log(text);
}

function parseArgs(argv) {
  const parsed = {
    mcpUrl: DEFAULT_MCP_URL,
    compareUrls: [],
    databaseId: null,
    databaseQuery: DEFAULT_DATABASE_QUERY,
    query: DEFAULT_QUERY,
    prefix: DEFAULT_PREFIX,
    iterations: DEFAULT_ITERATIONS,
    warmup: DEFAULT_WARMUP,
    outputJson: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mcp-url") {
      parsed.mcpUrl = requiredValue(argv, ++index, arg);
    } else if (arg === "--compare-url") {
      parsed.compareUrls.push(requiredValue(argv, ++index, arg));
    } else if (arg === "--database-id") {
      parsed.databaseId = requiredValue(argv, ++index, arg);
    } else if (arg === "--database-query") {
      parsed.databaseQuery = requiredValue(argv, ++index, arg);
    } else if (arg === "--query") {
      parsed.query = requiredValue(argv, ++index, arg);
    } else if (arg === "--prefix") {
      parsed.prefix = requiredValue(argv, ++index, arg);
    } else if (arg === "--iterations") {
      parsed.iterations = parsePositiveInt(requiredValue(argv, ++index, arg), arg);
    } else if (arg === "--warmup") {
      parsed.warmup = parseNonNegativeInt(requiredValue(argv, ++index, arg), arg);
    } else if (arg === "--output-json") {
      parsed.outputJson = requiredValue(argv, ++index, arg);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/bench/wiki-mcp-latency.mjs [options]

Options:
  --mcp-url <url>           MCP endpoint (default: ${DEFAULT_MCP_URL})
  --compare-url <url>       Also benchmark another endpoint and emit cross-endpoint comparisons
  --database-id <id>        Skip find_databases selection
  --database-query <text>   Public DB discovery query (default: ${DEFAULT_DATABASE_QUERY})
  --query <text>            Search/context task query (default: ${DEFAULT_QUERY})
  --prefix <path>           Search/list/context namespace (default: ${DEFAULT_PREFIX})
  --iterations <n>          Measured iterations per scenario (default: ${DEFAULT_ITERATIONS})
  --warmup <n>              Warmup iterations per scenario (default: ${DEFAULT_WARMUP})
  --output-json <path>      Write JSON report
`);
}
