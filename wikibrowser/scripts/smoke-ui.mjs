import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";

const smokeWaitMs = 30_000;
const pollMs = 500;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

async function main() {
  const url = readUrl();
  const target = parseSmokeTargetUrl(url);
  const searchUrl = `${target.origin}/${encodeURIComponent(target.databaseId)}/search`;
  const graphUrl = `${target.origin}/${encodeURIComponent(target.databaseId)}/graph?center=${encodeURIComponent(target.nodePath)}&depth=1`;
  const emptyGraphUrl = `${target.origin}/${encodeURIComponent(target.databaseId)}/graph`;
  const helpUrl = `${target.origin}/${encodeURIComponent(target.databaseId)}/help`;
  const targetContext = await readTargetContext(target.databaseId, target.nodePath);
  const targetNode = targetContext.node;
  const contentProbe = contentProbeFor(targetNode.content);
  const pathQuery = pathQueryFor(target.nodePath);
  const fullQuery = fullTextQueryFor(targetNode.content);

  assertNodeContextShape(targetContext, target.nodePath);
  run("open", [url]);
  assertSnapshotIncludes(contentProbe);
  assertSnapshotIncludes("Incoming Links");
  run("open", [`${url}?view=raw`]);
  assertSnapshotIncludes(contentProbe);
  run("open", [`${searchUrl}?q=${encodeURIComponent(pathQuery)}&kind=path`]);
  assertSnapshotIncludes(contentProbe);
  run("open", [`${searchUrl}?q=${encodeURIComponent(fullQuery)}&kind=full`]);
  assertSnapshotIncludes(target.nodePath);
  assertSnapshotIncludes("Full text");
  run("open", [`${url}?tab=query`]);
  assertSnapshotIncludes("Query");
  run("open", [graphUrl]);
  assertSnapshotIncludes("Local link graph");
  assertSnapshotIncludes(target.nodePath);
  run("open", [emptyGraphUrl]);
  assertSnapshotIncludes("Open Graph from a wiki page to inspect its local neighborhood.");
  run("open", [helpUrl]);
  assertSnapshotIncludes("Wiki browser help");
  assertSnapshotIncludes("Path search matches node paths.");
  assertSnapshotIncludes("Internet Identity is required");
  assertNoSnapshotText("Cannot reach IC host");

  console.log(`Wiki browser smoke OK: ${target.databaseId} ${target.nodePath}`);
}

export function parseSmokeTargetUrl(url) {
  const targetUrl = new URL(url);
  const segments = targetUrl.pathname.split("/").filter(Boolean);
  const databaseId = decodePathSegment(segments[0] ?? "");
  const path = segments
    .slice(1)
    .filter(Boolean)
    .map(decodePathSegment)
    .join("/");
  return {
    origin: targetUrl.origin,
    databaseId,
    nodePath: path ? `/${path}` : "/Wiki"
  };
}

function readUrl() {
  const argIndex = process.argv.indexOf("--url");
  const value = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.WIKI_BROWSER_SMOKE_URL;
  if (!value) {
    throw new Error("missing --url or WIKI_BROWSER_SMOKE_URL");
  }
  return value;
}

function assertSnapshotIncludes(text) {
  let lastOutput = "";
  const deadline = Date.now() + smokeWaitMs;
  while (Date.now() < deadline) {
    lastOutput = snapshotText();
    if (lastOutput.includes(text)) {
      return;
    }
    sleep(pollMs);
  }
  throw new Error(`snapshot missing ${text}\n${lastOutput}`);
}

async function readTargetContext(databaseId, nodePath) {
  const host = process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "https://icp0.io";
  const canisterId = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
  const agent = HttpAgent.createSync({ host });
  if (isLocalHost(host)) {
    await agent.fetchRootKey();
  }
  const actor = Actor.createActor(idlFactory, {
    agent,
    canisterId: Principal.fromText(canisterId)
  });
  const result = await actor.read_node_context({ database_id: databaseId, path: nodePath, link_limit: 20 });
  if ("Err" in result) {
    throw new Error(`smoke target node context is not readable: ${result.Err}`);
  }
  const raw = result.Ok[0];
  if (!raw) {
    throw new Error(`smoke target node context is missing: ${nodePath}`);
  }
  return normalizeNodeContext(raw);
}

function assertNodeContextShape(context, nodePath) {
  if (!context || typeof context !== "object" || !context.node) {
    throw new Error("node-context response must contain node");
  }
  if (!Array.isArray(context.incomingLinks) || !Array.isArray(context.outgoingLinks)) {
    throw new Error("node-context response must contain incomingLinks and outgoingLinks arrays");
  }
  const node = context.node;
  if (node.kind !== "file" || typeof node.content !== "string" || !node.content.trim()) {
    throw new Error(`smoke target must be an existing file with content: ${nodePath}`);
  }
}

function assertNoSnapshotText(text) {
  const output = snapshotText();
  if (output.includes(text)) {
    throw new Error(`snapshot unexpectedly included ${text}\n${output}`);
  }
}

function contentProbeFor(content) {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("- ["))
    .map((line) => line.replace(/^#+\s*/, "").replace(/^-\s*/, ""))
    .find((line) => line.length >= 12) ?? content.trim().slice(0, 40);
}

function pathQueryFor(path) {
  const name = path.split("/").filter(Boolean).at(-1) ?? "index.md";
  return name.replace(/\.[^.]+$/, "") || name;
}

function fullTextQueryFor(content) {
  const ignored = new Set(["facts", "related", "index", "events", "plans", "provenance", "summary", "extracted"]);
  const words = content.match(/[A-Za-z][A-Za-z0-9-]{4,}/g) ?? [];
  const candidate = words.find((word) => !ignored.has(word.toLowerCase()));
  if (!candidate) {
    throw new Error("smoke target content does not contain a usable full-text query term");
  }
  return candidate;
}

function snapshotText() {
  const output = run("snapshot", []);
  const path = output.match(/\[Snapshot\]\(([^)]+)\)/)?.[1];
  if (!path) {
    return output;
  }
  return `${output}\n${readFileSync(path, "utf8")}`;
}

function run(command, args) {
  const result = spawnSync("playwright-cli", [command, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) {
    throw new Error(output);
  }
  return output;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function normalizeNodeContext(raw) {
  return {
    node: {
      path: raw.node.path,
      kind: "Folder" in raw.node.kind ? "folder" : "File" in raw.node.kind ? "file" : "source",
      content: raw.node.content
    },
    incomingLinks: raw.incoming_links,
    outgoingLinks: raw.outgoing_links
  };
}

function isLocalHost(host) {
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?/i.test(host);
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function idlFactory({ IDL: idl }) {
  const NodeKind = idl.Variant({ File: idl.Null, Source: idl.Null, Folder: idl.Null });
  const LinkEdge = idl.Record({
    source_path: idl.Text,
    target_path: idl.Text,
    raw_href: idl.Text,
    link_text: idl.Text,
    link_kind: idl.Text,
    updated_at: idl.Int64
  });
  const Node = idl.Record({
    path: idl.Text,
    kind: NodeKind,
    content: idl.Text,
    created_at: idl.Int64,
    updated_at: idl.Int64,
    etag: idl.Text,
    metadata_json: idl.Text
  });
  const NodeContext = idl.Record({
    incoming_links: idl.Vec(LinkEdge),
    node: Node,
    outgoing_links: idl.Vec(LinkEdge)
  });
  const NodeContextRequest = idl.Record({ database_id: idl.Text, path: idl.Text, link_limit: idl.Nat32 });
  const ResultNodeContext = idl.Variant({ Ok: idl.Opt(NodeContext), Err: idl.Text });
  return idl.Service({
    read_node_context: idl.Func([NodeContextRequest], [ResultNodeContext], ["query"])
  });
}
