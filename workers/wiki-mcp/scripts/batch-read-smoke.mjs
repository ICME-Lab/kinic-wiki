import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_PATHS = [
  "/Sources/honojs__hono/provenance.md",
  "/Knowledge/sources/honojs__hono/curated/routing--420aa69ea5d3.md",
  "/Knowledge/sources/honojs__hono/llms-full/routing--5775bf3ff091.md"
];

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.notEqual(result.isError, true, `${name} returned a tool error`);
  assert.ok(result.structuredContent, `${name} omitted structuredContent`);
  return result.structuredContent;
}

export async function verifyBatchReads(client, databaseId, paths) {
  assert.ok(paths.length >= 2 && paths.length <= 10, "Provide 2–10 paths");
  const singles = [];
  for (const path of paths) {
    const one = await call(client, "read_paths", { database_id: databaseId, paths: [path] });
    assert.equal(one.results?.length, 1, "single read result count mismatch");
    const single = one.results[0];
    assert.notEqual(single.is_error, true, "single read item failed");
    assert.equal(single.metadata?.path, path, "single read path mismatch");
    assert.equal(single.metadata?.truncated, false, "single read was truncated");
    assert.equal(typeof single.text, "string", "single read omitted content");
    assert.equal(typeof single.id, "string", "single read omitted fetch id");
    singles.push(single);
  }
  const batch = await call(client, "read_paths", { database_id: databaseId, paths });
  assert.equal(batch.metadata?.batch_error, null, "read_paths batch failed");
  assert.equal(batch.metadata?.parse_error_count, 0, "read_paths row parsing failed");
  verifyItems(batch.results, singles, "read_paths");
  const fetched = await call(client, "fetch_many", { ids: singles.map((single) => single.id) });
  verifyItems(fetched.results, singles, "fetch_many");
  return { verifiedPaths: paths.length, singleReads: true, readPaths: true, fetchMany: true };
}

function verifyItems(items, singles, tool) {
  assert.equal(items?.length, singles.length, `${tool} result count mismatch`);
  items.forEach((item, index) => {
    assert.notEqual(item?.is_error, true, `${tool} item ${index} failed`);
    assert.equal(item?.metadata?.truncated, false, `${tool} item ${index} was truncated`);
    assert.equal(item?.metadata?.path, singles[index].metadata.path, `${tool} item ${index} path mismatch`);
    assert.equal(item?.metadata?.etag, singles[index].metadata.etag, `${tool} item ${index} changed during smoke`);
    // Do not include private text in assertion diagnostics.
    assert.ok(item?.text === singles[index].text, `${tool} item ${index} content mismatch`);
  });
}

async function main(argv) {
  const options = {
    serverUrl: "https://wiki-mcp.kinic.xyz/mcp",
    databaseId: "db_23dhmsxlhukv",
    paths: [], authenticated: false, openBrowser: false,
    authCachePath: undefined, query: "", task: "Verify existing wiki batch reads."
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--authenticated") options.authenticated = true;
    else if (arg === "--open") options.openBrowser = true;
    else if (["--server-url", "--database-id", "--path", "--auth-cache"].includes(arg)) {
      const value = argv[++index];
      assert.ok(value && !value.startsWith("--"), `${arg} requires a value`);
      if (arg === "--path") options.paths.push(value);
      else options[{ "--server-url": "serverUrl", "--database-id": "databaseId", "--auth-cache": "authCachePath" }[arg]] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.paths.length === 0) {
    assert.equal(options.databaseId, "db_23dhmsxlhukv", "Custom databases require explicit --path arguments");
    options.paths = DEFAULT_PATHS;
  }
  assert.ok(options.paths.length >= 2 && options.paths.length <= 10, "Provide 2–10 paths");
  let session;
  if (options.authenticated) {
    const { defaultAuthCachePath, openAuthenticatedSession } = await import("./staging-smoke.mjs");
    options.authCachePath ??= defaultAuthCachePath();
    session = await openAuthenticatedSession(options);
  }
  else {
    const client = new Client({ name: "kinic-wiki-batch-read-smoke", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(options.serverUrl)));
    session = { client, close: () => client.close() };
  }
  try {
    console.log(JSON.stringify(await verifyBatchReads(session.client, options.databaseId, options.paths)));
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error("Batch read smoke failed; check authentication, item errors, truncation, and concurrent content changes.");
    process.exitCode = 1;
  });
}
