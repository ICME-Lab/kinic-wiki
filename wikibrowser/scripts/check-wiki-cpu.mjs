// Read-only HTTP probe and Workers Logs acceptance gate. Requires authenticated cf.
// Cases JSON: [{ "name": "normal", "path": "/db/.../note.md", "expectArticle": true, "status": 200 }]
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  origin: { type: "string" }, worker: { type: "string" }, cases: { type: "string" },
  "report-only": { type: "boolean", default: false }
} });
if (!values.origin || !values.worker || !values.cases) {
  throw new Error("Usage: node scripts/check-wiki-cpu.mjs --origin https://... --worker NAME --cases cases.json [--report-only]");
}
const origin = new URL(values.origin);
if (origin.protocol !== "https:") throw new Error("Use the deployed HTTPS Worker origin");
const cases = JSON.parse(await readFile(values.cases, "utf8"));
if (!Array.isArray(cases) || cases.length === 0 || cases.length > 6) throw new Error("Provide 1–6 public test cases");
for (const item of cases) {
  if (!item.name || typeof item.path !== "string" || !item.path.startsWith("/db/")) throw new Error("Each case needs a name and /db/ path");
  if (new URL(item.path, origin).origin !== origin.origin) throw new Error("All cases must use the selected Worker origin");
}
// Use a readable marker: opaque UUID query values can be redacted in Workers Logs.
const runId = `wiki-cpu-${Date.now().toString(36)}`;
const from = Date.now() - 1000;
const failures = [];
const expected = new Map();
const http = [];
for (const [index, item] of cases.entries()) {
  for (const concurrency of [1, 5]) {
    const label = `${index}-${concurrency}`;
    expected.set(label, item.name);
    const url = new URL(item.path, origin);
    url.searchParams.set("wiki_cpu_probe", runId);
    url.searchParams.set("wiki_cpu_case", label);
    const statuses = [];
    for (let batch = 0; batch < 20; batch += concurrency) {
      await Promise.all(Array.from({ length: concurrency }, async () => {
        try {
          const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
          const html = await response.text();
          statuses.push(response.status);
          if (response.status !== (item.status ?? 200)) failures.push(`${label}: unexpected HTTP ${response.status}`);
          if (response.headers.get("cache-control") !== "no-store") failures.push(`${label}: missing no-store`);
          if (html.includes('class="wiki-seo-document') !== (item.expectArticle ?? true)) failures.push(`${label}: unexpected article presence`);
        } catch (error) {
          statuses.push(0);
          failures.push(`${label}: ${error.message}`);
        }
      }));
    }
    http.push({ name: item.name, label, concurrency, statuses });
  }
}

// Do not substitute HTTP elapsed time for CPU time. Query invocation logs only.
let metrics = [];
for (let attempt = 0; attempt < 6; attempt++) {
  const body = {
    queryId: "wiki-cpu-acceptance", dry: true, view: "calculations", limit: 100,
    timeframe: { from, to: Date.now() },
    parameters: {
      limit: 100,
      filters: [
        { key: "$workers.scriptName", operation: "eq", value: values.worker, type: "string" },
        { key: "$metadata.type", operation: "eq", value: "cf-worker-event", type: "string" },
        { key: "$workers.event.search.wiki_cpu_probe", operation: "eq", value: runId, type: "string" }
      ],
      calculations: [
        { operator: "count", alias: "requests" },
        { operator: "p95", key: "$workers.cpuTimeMs", alias: "cpu_p95" },
        { operator: "max", key: "$workers.cpuTimeMs", alias: "cpu_max" }
      ],
      groupBys: [
        { type: "string", value: "$workers.event.search.wiki_cpu_case" },
        { type: "string", value: "$workers.outcome" }
      ]
    }
  };
  const query = JSON.parse(execFileSync("cf", ["observability", "telemetry", "query", "--body", JSON.stringify(body)], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }));
  metrics = (query.calculations ?? []).map(({ alias, aggregates }) => ({ alias, aggregates }));
  const counts = metrics.find((metric) => metric.alias === "requests")?.aggregates ?? [];
  if ([...expected.keys()].every((label) => counts.filter((row) => group(row, "$workers.event.search.wiki_cpu_case") === label).reduce((sum, row) => sum + row.value, 0) >= 20)) break;
  if (attempt < 5) await delay(5000);
}
const counts = metrics.find((metric) => metric.alias === "requests")?.aggregates ?? [];
for (const label of expected.keys()) {
  const rows = counts.filter((row) => group(row, "$workers.event.search.wiki_cpu_case") === label);
  if (rows.reduce((sum, row) => sum + row.value, 0) !== 20 || rows.some((row) => row.sampleInterval !== 1)) failures.push(`${label}: missing or sampled invocation logs`);
  for (const row of rows) {
    if (group(row, "$workers.outcome") !== "ok") failures.push(`${label}: invocation outcome ${group(row, "$workers.outcome")}`);
  }
}
for (const row of metrics.find((metric) => metric.alias === "cpu_p95")?.aggregates ?? []) {
  if (typeof row.value !== "number" || row.value >= 8) failures.push(`${group(row, "$workers.event.search.wiki_cpu_case")}: CPU p95 must be below 8ms (${row.value})`);
}
if (!(metrics.find((metric) => metric.alias === "cpu_p95")?.aggregates?.length)) failures.push("CPU metrics unavailable");
console.log(JSON.stringify({ runId, worker: values.worker, origin: origin.origin, http, metrics, passed: failures.length === 0, failures: [...new Set(failures)] }, null, 2));
if (failures.length && !values["report-only"]) process.exitCode = 1;

function group(row, key) {
  return row.groups?.find((entry) => entry.key === key)?.value;
}
