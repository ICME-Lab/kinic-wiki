#!/usr/bin/env node
// Where: workers/wiki-mcp/scripts/seed-review-fixture.mjs
// What: Idempotently seeds the private OpenAI review fixture through the authenticated MCP contract.
// Why: Review tests need stable evidence without overwriting unrelated user content or exposing credentials.

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  REVIEW_DATABASE_NAME,
  REVIEW_FILES,
  REVIEW_FOLDERS,
  REVIEW_SCRATCH_PREFIX
} from "./review-fixture.mjs";
import { openAuthenticatedSession } from "./staging-smoke.mjs";

export { REVIEW_DATABASE_NAME, REVIEW_FILES, REVIEW_FOLDERS } from "./review-fixture.mjs";

export function missingReviewFolders(entries) {
  const existing = new Set(entries.map((entry) => entry?.path).filter((path) => typeof path === "string"));
  return REVIEW_FOLDERS.filter((path) => !existing.has(path));
}

export function exactNodeContent(result) {
  const text = toolResultText(result);
  const marker = "Content:\n";
  const index = text.indexOf(marker);
  return index === -1 ? null : text.slice(index + marker.length);
}

export function assertCompleteInventory(result) {
  assertToolSucceeded("list fixture inventory", result);
  if (result.structuredContent?.metadata?.truncated !== false) {
    throw new Error("Review fixture inventory is truncated or missing truncation metadata");
  }
  if (!Array.isArray(result.structuredContent?.entries)) {
    throw new Error("Review fixture inventory is missing entries");
  }
  return result.structuredContent.entries;
}

export function fixtureWritePlan(readResults) {
  const writes = [];
  for (let index = 0; index < REVIEW_FILES.length; index += 1) {
    const fixture = REVIEW_FILES[index];
    const result = readResults[index];
    if (isNodeNotFound(result)) {
      writes.push({ path: fixture.path, kind: "file", content: fixture.content, metadata_json: fixture.metadata_json });
      continue;
    }
    assertToolSucceeded(`read_path ${fixture.path}`, result);
    if (exactNodeContent(result) !== fixture.content) {
      throw new Error(`Refusing to overwrite non-fixture content at ${fixture.path}`);
    }
    if (!sameJson(result.structuredContent?.metadata?.metadata_json, fixture.metadata_json)) {
      throw new Error(`Refusing to accept unexpected fixture metadata at ${fixture.path}`);
    }
  }
  return writes;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const session = await openAuthenticatedSession({
    serverUrl: options.serverUrl,
    databaseId: undefined,
    path: undefined,
    writeSmokePath: `${REVIEW_SCRATCH_PREFIX}/__scope_request__.md`,
    query: REVIEW_DATABASE_NAME,
    task: "Seed the OpenAI review fixture.",
    openBrowser: options.openBrowser,
    resetAuth: options.resetAuth,
    authCachePath: options.authCachePath
  });
  try {
    const discovery = await session.client.callTool({
      name: "find_databases",
      arguments: { query: REVIEW_DATABASE_NAME, limit: 50 }
    });
    assertToolSucceeded("find_databases", discovery);
    const databases = discovery.structuredContent?.databases?.filter((database) => database?.name === REVIEW_DATABASE_NAME) ?? [];
    if (databases.length !== 1 || typeof databases[0]?.database_id !== "string") {
      throw new Error(`Expected exactly one database named ${REVIEW_DATABASE_NAME}, found ${databases.length}`);
    }
    const databaseId = databases[0].database_id;
    const inventory = await session.client.callTool({
      name: "list",
      arguments: { database_id: databaseId, prefix: "/", recursive: true, limit: 99 }
    });
    const missingFolders = missingReviewFolders(assertCompleteInventory(inventory));
    if (missingFolders.length > 0) {
      const createdFolders = await session.client.callTool({
        name: "mutate_nodes_batch",
        arguments: {
          database_id: databaseId,
          operations: missingFolders.map((path) => ({ type: "mkdir", path }))
        }
      });
      assertToolSucceeded("mutate_nodes_batch fixture folders", createdFolders);
    }

    const reads = [];
    for (const fixture of REVIEW_FILES) {
      reads.push(await session.client.callTool({
        name: "read_path",
        arguments: { database_id: databaseId, path: fixture.path }
      }));
    }
    const writes = fixtureWritePlan(reads);
    if (writes.length > 0) {
      const written = await session.client.callTool({
        name: "write_nodes",
        arguments: { database_id: databaseId, nodes: writes }
      });
      assertToolSucceeded("write_nodes fixture files", written);
    }
    const verificationReads = [];
    for (const fixture of REVIEW_FILES) {
      verificationReads.push(await session.client.callTool({
        name: "read_path",
        arguments: { database_id: databaseId, path: fixture.path }
      }));
    }
    const remainingWrites = fixtureWritePlan(verificationReads);
    if (remainingWrites.length > 0) {
      throw new Error(`Fixture verification still requires ${remainingWrites.length} write(s)`);
    }
    console.log(JSON.stringify({
      ok: true,
      database_name: REVIEW_DATABASE_NAME,
      database_id: databaseId,
      folders_created: missingFolders.length,
      files_created: writes.length,
      files_verified: REVIEW_FILES.length
    }, null, 2));
  } finally {
    await session.close();
  }
}

function parseArgs(args) {
  const values = new Map();
  let openBrowser = false;
  let resetAuth = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--open") {
      openBrowser = true;
      continue;
    }
    if (arg === "--reset-auth") {
      resetAuth = true;
      continue;
    }
    if (!["--server-url", "--auth-cache"].includes(arg) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(`Invalid argument: ${arg}`);
    }
    values.set(arg, args[++index]);
  }
  return {
    serverUrl: values.get("--server-url") ?? "https://wiki-private-mcp.kinic.xyz/mcp",
    authCachePath: values.get("--auth-cache") ?? process.env.MCP_REVIEW_AUTH_CACHE ?? join(homedir(), ".local", "state", "kinic-wiki", "mcp-review-oauth.json"),
    openBrowser,
    resetAuth
  };
}

function isNodeNotFound(result) {
  if (result?.isError !== true) return false;
  try {
    return JSON.parse(toolResultText(result))?.error === "node not found";
  } catch {
    return false;
  }
}

function assertToolSucceeded(name, result) {
  if (result?.isError === true) throw new Error(`${name} returned an MCP tool error`);
}

function toolResultText(result) {
  return result?.content?.filter((item) => item.type === "text").map((item) => item.text).join("") ?? "";
}

function sameJson(actual, expected) {
  if (typeof actual !== "string") return false;
  try {
    return stableJson(JSON.parse(actual)) === stableJson(JSON.parse(expected));
  } catch {
    return false;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Review fixture seeding failed");
    process.exitCode = 1;
  });
}
