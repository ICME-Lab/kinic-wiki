import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  buildScenarios,
  compareResults,
  toolCapabilities,
  toolCallResult,
} from "./wiki-mcp-latency.mjs";

const node = (path) => ({
  id: `id:${path}`,
  text: "body",
  metadata: { path, etag: "v1" },
});
const response = (payload) => ({
  ok: true,
  bytes: 1,
  http_status: 200,
  result: {
    content: [{ type: "text", text: "Result 1\nContent:\nbody" }],
    structuredContent: payload,
  },
});

test("one path still measures single, batch, and sequential scenarios using read_paths", async () => {
  const calls = [];
  const scenarios = buildScenarios(
    "db",
    { primary_path: "/page", paths: ["/page"], fetch_ids: ["id:/page"] },
    toolCapabilities([{ name: "read_paths" }]),
    async (name, args) => {
      calls.push({ name, args });
      return { ok: true, bytes: 1 };
    },
  );
  const reads = scenarios.filter((s) => s.name.startsWith("read_paths"));
  assert.deepEqual(
    reads.map((s) => s.name),
    ["read_paths_single", "read_paths", "read_paths_sequential_same_count"],
  );
  for (const scenario of reads) await scenario.run();
  assert.deepEqual(
    calls,
    Array.from({ length: 3 }, () => ({
      name: "read_paths",
      args: { database_id: "db", paths: ["/page"] },
    })),
  );
  const comparisons = compareResults([
    ...reads.map((r) => ({ name: r.name, latency_ms: { avg: 1 } })),
    { name: "fetch_many", latency_ms: { avg: 2 } },
  ]);
  assert.equal(comparisons.fetch_many_vs_sequential_read_paths_avg_ratio, 2);
  assert.equal(comparisons.read_paths_vs_sequential_read_paths_avg_ratio, 1);
  assert.equal(comparisons.read_paths_single_vs_fetch_many_avg_ratio, 0.5);
});

test("reads structured output and fails closed on item errors, mismatched paths and envelopes", () => {
  const args = { paths: ["/page"] };
  assert.equal(
    toolCallResult("read_paths", args, response({ results: [node("/page")] }))
      .ok,
    true,
  );
  for (const payload of [
    { results: [{ path: "/page", is_error: true, error: "node not found" }] },
    { results: [node("/other")] },
    { results: [] },
    {},
    { results: [node("/page")], metadata: { batch_error: "failed" } },
  ])
    assert.equal(
      toolCallResult("read_paths", args, response(payload)).ok,
      false,
    );
  assert.equal(
    toolCallResult(
      "fetch_many",
      { ids: ["id:/page"] },
      response({ results: [node("/page")] }),
    ).ok,
    true,
  );
  assert.equal(
    toolCallResult(
      "fetch_many",
      { ids: ["id:/page"] },
      response({
        results: [{ id: "id:/page", is_error: true, error: "denied" }],
      }),
    ).ok,
    false,
  );
});

for (const itemError of [false, true])
  test(`CLI measures all single-path scenarios and exits ${itemError ? "unsuccessfully on item failure" : "successfully"}`, async () => {
    const calls = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      let result;
      if (request.method === "tools/list")
        result = {
          tools: ["find_databases", "search", "fetch_many", "read_paths"].map(
            (name) => ({ name }),
          ),
        };
      else {
        const { name, arguments: args } = request.params;
        calls.push({ name, args });
        let structuredContent;
        if (name === "find_databases")
          structuredContent = { databases: [{ database_id: "db" }] };
        else if (name === "search")
          structuredContent = { results: [node("/page")] };
        else
          structuredContent = {
            results: itemError
              ? [
                  {
                    path: "/page",
                    id: "id:/page",
                    is_error: true,
                    error: "denied",
                  },
                ]
              : [node("/page")],
          };
        result = {
          content: [{ type: "text", text: "Model-facing prose, not JSON" }],
          structuredContent,
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const child = spawn(
        process.execPath,
        [
          new URL("./wiki-mcp-latency.mjs", import.meta.url).pathname,
          "--mcp-url",
          `http://127.0.0.1:${server.address().port}/mcp`,
          "--database-id",
          "db",
          "--iterations",
          "1",
          "--warmup",
          "0",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "",
        errors = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (errors += d));
      const [code] = await once(child, "close");
      assert.equal(errors, "");
      assert.equal(code, itemError ? 1 : 0);
      const report = JSON.parse(output);
      assert.equal(report.ok, !itemError);
      for (const name of [
        "read_paths_single",
        "read_paths",
        "read_paths_sequential_same_count",
      ]) {
        const entry = report.results.find((r) => r.name === name);
        assert.ok(entry, name);
        assert.equal(entry.ok, !itemError);
      }
      assert.equal(calls.filter((c) => c.name === "read_paths").length, 3);
      assert.ok(
        calls
          .filter((c) => c.name === "read_paths")
          .every((c) => c.args.paths.length === 1),
      );
      assert.equal(
        calls.some((c) => c.name === "read_path"),
        false,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
