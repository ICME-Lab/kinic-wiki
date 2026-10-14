// Deterministic VFS boundary used only by evaluation. No network or credentials.
export class KinicMutationError extends Error {
  constructor(code, failedIndex = null, conflictPath = null, message = code) {
    super(message);
    Object.assign(this, { code, failedIndex, conflictPath });
  }
}
const state = () => globalThis.__wikiFixture;
const key = (db, path) => `${db}:${path}`;
const clone = (x) => structuredClone(x);
export function resolveCanisterId() {
  return "eval-canister";
}
export async function listDatabases() {
  return ["db_eval", "db_beta"].map((databaseId) => ({
    databaseId,
    name: databaseId,
    description: "Synthetic evaluation wiki",
    llmSummary: null,
    tagsJson: "[]",
    status: "active",
  }));
}
export async function readNode(_env, db, path) {
  if (path.startsWith("/Restricted")) throw new Error("forbidden");
  const n = state().nodes[key(db, path)];
  if (n) state().reads.push(key(db, path));
  return n ? clone(n) : null;
}
export async function createNodeReader() {
  return {
    readMany: async (db, paths) =>
      Promise.all(
        paths.map(async (path) => {
          try {
            return { node: await readNode({}, db, path), error: null };
          } catch (e) {
            return { node: null, error: e.message };
          }
        }),
      ),
  };
}
export async function listNodes(_env, db, prefix, recursive, limit) {
  return Object.entries(state().nodes)
    .filter(([k, n]) => k.startsWith(db + ":") && n.path.startsWith(prefix))
    .slice(0, limit)
    .map(([, n]) => ({ ...clone(n), hasChildren: n.kind === "folder" }));
}
export async function searchNodes(_env, db, query, prefix, limit) {
  const words = query.split(/[\s　]+/).filter(Boolean);
  return Object.entries(state().nodes)
    .filter(
      ([k, n]) =>
        k.startsWith(db + ":") &&
        n.kind !== "folder" &&
        n.path.startsWith(prefix) &&
        words.some(
          (w) =>
            (n.path + n.content).includes(w) ||
            (/承認|リリース/.test(w) && /承認/.test(n.content)),
        ),
    )
    .slice(0, limit)
    .map(([, n]) => ({
      path: n.path,
      kind: n.kind,
      score: 1,
      snippet: n.content.slice(0, 60),
      preview: { excerpt: n.content.slice(0, 60), matchReason: "content" },
      matchReasons: ["content"],
    }));
}
export async function queryContext(_env, input) {
  const hits = await searchNodes(
    {},
    input.databaseId,
    input.task,
    input.namespace,
    20,
  );
  const nodes = [];
  for (const h of hits)
    nodes.push({
      node: await readNode({}, input.databaseId, h.path),
      incomingLinks: [],
      outgoingLinks: [],
    });
  return {
    task: input.task,
    namespace: input.namespace,
    truncated: false,
    nodes,
    graphLinks: [],
    evidence: [],
    searchHits: hits,
  };
}
export async function memoryManifest() {
  state().manifestRead = true;
  return {
    apiVersion: "1",
    purpose: "Synthetic wiki",
    enabledStores: ["vfs"],
    roots: [
      { path: "/Knowledge", kind: "folder" },
      { path: "/Sources", kind: "folder" },
    ],
    entryRoots: [],
    capabilities: [{ name: "query_context", description: "Read context" }],
    canonicalRoles: [],
    writePolicy: "etag",
    recommendedEntrypoint: "context",
    maxDepth: 3,
    maxQueryLimit: 20,
    budgetUnit: "tokens",
  };
}
function fail(code, index, path) {
  throw new KinicMutationError(code, index, path);
}
function ack(n) {
  return { path: n.path, kind: n.kind, etag: n.etag, updatedAt: n.updatedAt };
}
export async function mutateNodesBatch(_env, db, ops) {
  const s = state();
  s.mutationAttempts++;
  if (s.conflictPending) {
    s.conflictPending = false;
    const n = s.nodes[key(db, "/Knowledge/note.md")];
    n.content += "\n同僚の追記";
    n.etag = "concurrent-v2";
    s.externalUpdates++;
  }
  const nodes = clone(s.nodes);
  const results = [];
  for (const [i, op] of ops.entries()) {
    const v = op.value,
      p = v.path ?? v.fromPath,
      k = key(db, p),
      n = nodes[k];
    if (op.type !== "mkdir" && n && v.expectedEtag !== n.etag)
      fail("etag_conflict", i, p);
    if (!["write", "append", "mkdir"].includes(op.type) && !n)
      fail("not_found", i, p);
    let result, next;
    if (op.type === "write" || op.type === "append") {
      if (!nodes[key(db, p.slice(0, p.lastIndexOf("/")))])
        fail("not_found", i, p);
      next = {
        path: p,
        kind: v.kind ?? n?.kind ?? "file",
        content:
          op.type === "write"
            ? v.content
            : (n?.content ?? "") +
              (n?.content ? (v.separator ?? "\n") : "") +
              v.content,
        metadataJson: v.metadataJson ?? n?.metadataJson ?? "{}",
        createdAt: n?.createdAt ?? "1",
      };
      result = { created: !n };
    } else if (op.type === "edit" || op.type === "multi_edit") {
      let content = n.content,
        count = 0;
      for (const e of op.type === "edit" ? [v] : v.edits) {
        if (!e.oldText) fail("invalid_operation", i, p);
        const hits = content.split(e.oldText).length - 1;
        if (!hits || (op.type === "edit" && !v.replaceAll && hits > 1))
          fail("invalid_operation", i, p);
        content = content.split(e.oldText).join(e.newText);
        count += hits;
      }
      next = { ...n, content };
      result = { replacementCount: count };
    } else if (op.type === "mkdir") {
      if (n && n.kind !== "folder") fail("invalid_operation", i, p);
      if (!n && !nodes[key(db, p.slice(0, p.lastIndexOf("/")))])
        fail("not_found", i, p);
      if (!n)
        nodes[k] = {
          path: p,
          kind: "folder",
          content: "",
          metadataJson: "{}",
          createdAt: "1",
          updatedAt: "2",
          etag: `v${++s.revision}`,
        };
      results.push({ type: op.type, value: { path: p, created: !n } });
      continue;
    } else if (op.type === "move") {
      const target = nodes[key(db, v.toPath)];
      if (target && (!v.overwrite || v.expectedTargetEtag !== target.etag))
        fail("etag_conflict", i, v.toPath);
      if (!nodes[key(db, v.toPath.slice(0, v.toPath.lastIndexOf("/")))])
        fail("not_found", i, v.toPath);
      delete nodes[k];
      next = { ...n, path: v.toPath };
      result = { fromPath: p, overwrote: !!target };
    } else if (op.type === "delete") {
      delete nodes[k];
      results.push({ type: op.type, value: { path: p } });
      continue;
    }
    next = { ...next, updatedAt: "2", etag: `v${++s.revision}` };
    nodes[key(db, next.path)] = next;
    results.push({ type: op.type, value: { node: ack(next), ...result } });
  }
  s.nodes = nodes;
  s.commits.push(clone(ops));
  return results;
}
export async function writeNodes(env, db, nodes) {
  return (
    await mutateNodesBatch(
      env,
      db,
      nodes.map((value) => ({ type: "write", value })),
    )
  ).map((r) => r.value);
}
