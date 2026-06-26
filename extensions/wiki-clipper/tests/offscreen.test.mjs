// Where: extensions/wiki-clipper/tests/offscreen.test.mjs
// What: Unit tests for authenticated offscreen VFS writes.
// Why: Service workers delegate II-backed writes to offscreen documents.
import assert from "node:assert/strict";
import test from "node:test";
import {
  authStatus,
  handleOffscreenMessage,
  listWritableDatabases,
  saveEvidenceSource,
  setOffscreenDepsForTest,
  triggerSourceGeneration,
  webSourceExists
} from "../src/offscreen.js";

test("saveEvidenceSource writes with authenticated identity", async () => {
  const calls = [];
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { tag: "identity" }, principal: "principal-1" }),
    createVfsActor: async (config) => {
      calls.push(["create", config.identity, config.databaseId]);
      return {
        ...writeCyclesActorMethods(),
        async read_node(databaseId, path) {
          calls.push(["read", databaseId, path]);
          return { Ok: [{ etag: "etag-1" }] };
        },
        async mkdir_node(request) {
          calls.push(["mkdir", request.database_id, request.path]);
          return { Ok: { created: true, path: request.path } };
        },
        async write_source_for_generation(request) {
          calls.push(["write", request.database_id, request.path, request.expected_etag, request.session_nonce]);
          return {
            Ok: {
              write: { created: false, node: { etag: "etag-2" } },
              session_nonce: request.session_nonce
            }
          };
        }
      };
    }
  });
  try {
    const result = await saveEvidenceSource(evidenceSource(), config());

    assert.equal(result.etag, "etag-2");
    assert.equal(result.principal, "principal-1");
    assert.deepEqual(calls.slice(0, 4), [
      ["create", { tag: "identity" }, "team-db"],
      ["read", "team-db", "/Sources/chatgpt/abc.md"],
      ["mkdir", "team-db", "/Sources"],
      ["mkdir", "team-db", "/Sources/chatgpt"]
    ]);
    assert.equal(calls[4][0], "write");
    assert.equal(calls[4][1], "team-db");
    assert.equal(calls[4][2], "/Sources/chatgpt/abc.md");
    assert.deepEqual(calls[4][3], ["etag-1"]);
    assert.equal(typeof calls[4][4], "string");
    assert.equal(result.sourceRunSessionNonce, calls[4][4]);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("saveEvidenceSource rejects unauthenticated sessions", async () => {
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: false, identity: null, principal: null })
  });
  try {
    await assert.rejects(() => saveEvidenceSource(evidenceSource(), config()), /UNAUTHENTICATED/);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("webSourceExists returns false when evidence source is missing", async () => {
  const calls = [];
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { tag: "identity" }, principal: "principal-1" }),
    createVfsActor: async (config) => {
      calls.push(["create", config.identity, config.databaseId]);
      return {
        async read_node(databaseId, path) {
          calls.push(["read", databaseId, path]);
          return { Ok: [] };
        }
      };
    }
  });
  try {
    const result = await handleOffscreenMessage({
      target: "offscreen",
      type: "web-source-exists",
      sourcePath: "/Sources/web/abc.md",
      config: config()
    });

    assert.deepEqual(result, { exists: false, path: "/Sources/web/abc.md", etag: null });
    assert.deepEqual(calls, [
      ["create", { tag: "identity" }, "team-db"],
      ["read", "team-db", "/Sources/web/abc.md"]
    ]);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("webSourceExists returns true when evidence source exists", async () => {
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { tag: "identity" }, principal: "principal-1" }),
    createVfsActor: async () => ({
      async read_node() {
        return { Ok: [{ etag: "etag-source" }] };
      }
    })
  });
  try {
    const result = await webSourceExists("/Sources/web/abc.md", config());

    assert.deepEqual(result, { exists: true, path: "/Sources/web/abc.md", etag: "etag-source" });
  } finally {
    setOffscreenDepsForTest();
  }
});

test("webSourceExists rejects unauthenticated sessions", async () => {
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: false, identity: null, principal: null })
  });
  try {
    await assert.rejects(() => webSourceExists("/Sources/web/abc.md", config()), /UNAUTHENTICATED/);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("saveEvidenceSource reloads auth client once before writing after a stale unauthenticated snapshot", async () => {
  const calls = [];
  let snapshotCalls = 0;
  setOffscreenDepsForTest({
    authSnapshot: async () => {
      snapshotCalls += 1;
      return snapshotCalls === 1
        ? { isAuthenticated: false, identity: null, principal: null }
        : { isAuthenticated: true, identity: { tag: "identity-2" }, principal: "principal-2" };
    },
    resetAuthClient: async () => calls.push(["reset"]),
    createVfsActor: async (config) => {
      calls.push(["create", config.identity]);
      return {
        ...writeCyclesActorMethods(),
        async read_node() {
          return { Ok: [] };
        },
        async mkdir_node(request) {
          calls.push(["mkdir", request.path]);
          return { Ok: { created: true, path: request.path } };
        },
        async write_source_for_generation(request) {
          calls.push(["write", request.database_id, request.path]);
          return {
            Ok: {
              write: { created: true, node: { etag: "etag-after-reset" } },
              session_nonce: request.session_nonce
            }
          };
        }
      };
    }
  });
  try {
    const result = await saveEvidenceSource(evidenceSource(), config());

    assert.equal(result.principal, "principal-2");
    assert.equal(result.etag, "etag-after-reset");
    assert.deepEqual(calls[0], ["reset"]);
    assert.deepEqual(calls[1], ["create", { tag: "identity-2" }]);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("listWritableDatabases reloads auth client once before listing databases", async () => {
  let snapshotCalls = 0;
  let resetCount = 0;
  setOffscreenDepsForTest({
    authSnapshot: async () => {
      snapshotCalls += 1;
      return snapshotCalls === 1
        ? { isAuthenticated: false, identity: null, principal: null }
        : { isAuthenticated: true, identity: { tag: "identity-2" }, principal: "principal-2" };
    },
    resetAuthClient: async () => {
      resetCount += 1;
    },
    createVfsActor: async () => ({
      async list_databases() {
        return { Ok: [rawDatabase("team-db", "Team DB", "Writer", "Active")] };
      },
      async get_cycles_billing_config() {
        return {
          Ok: {
            kinic_ledger_canister_id: "ryjl3-tyaaa-aaaaa-aaaba-cai",
            billing_authority_id: "rrkah-fqaaa-aaaaa-aaaaq-cai",
            cycles_per_kinic: 1n,
            min_update_cycles: 10_000n
          }
        };
      }
    })
  });
  try {
    const result = await listWritableDatabases(config());

    assert.equal(resetCount, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].databaseId, "team-db");
  } finally {
    setOffscreenDepsForTest();
  }
});

test("reset-auth-client message resets offscreen auth state", async () => {
  let resetCount = 0;
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { tag: "identity" }, principal: "principal-1" }),
    resetAuthClient: async () => {
      resetCount += 1;
    }
  });
  try {
    const result = await handleOffscreenMessage({ target: "offscreen", type: "reset-auth-client" });

    assert.deepEqual(result, { reset: true });
    assert.equal(resetCount, 1);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("saveEvidenceSource rejects suspended cycles before writing", async () => {
  const calls = [];
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { tag: "identity" }, principal: "principal-1" }),
    createVfsActor: async () => ({
      ...writeCyclesActorMethods({ suspendedAtMs: 1n }),
      async read_node() {
        calls.push(["read"]);
        return { Ok: [] };
      },
      async mkdir_node() {
        calls.push(["mkdir"]);
        return { Ok: { created: true, path: "/Sources" } };
      },
      async write_node() {
        calls.push(["write"]);
        return { Ok: { created: true, node: { etag: "etag-request" } } };
      }
    })
  });
  try {
    await assert.rejects(() => saveEvidenceSource(evidenceSource(), config()), /cycles are suspended/);

    assert.deepEqual(calls, []);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("triggerSourceGeneration calls source run route with issued source-run session", async () => {
  const fetchCalls = [];
  setOffscreenDepsForTest({
    fetch: async (url, init) => {
      fetchCalls.push([url, init]);
      return Response.json({ accepted: true }, { status: 202 });
    }
  });
  try {
    const result = await triggerSourceGeneration(config(), "/Sources/web/abc.md", "etag-source", "session-source");

    assert.equal(result.triggered, true);
    assert.equal(result.sourcePath, "/Sources/web/abc.md");
    assert.equal(result.sourceEtag, "etag-source");
    assert.equal(fetchCalls[0][0], "https://wiki.kinic.xyz/api/source/run");
    assert.deepEqual(JSON.parse(fetchCalls[0][1].body), {
      canisterId: "xis3j-paaaa-aaaai-axumq-cai",
      databaseId: "team-db",
      sourcePath: "/Sources/web/abc.md",
      sourceEtag: "etag-source",
      sessionNonce: "session-source"
    });
  } finally {
    setOffscreenDepsForTest();
  }
});

test("authStatus returns principal without identity", async () => {
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { secret: "identity" }, principal: "principal-1" })
  });
  try {
    const result = await authStatus();

    assert.deepEqual(result, { isAuthenticated: true, principal: "principal-1" });
    assert.equal("identity" in result, false);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("listWritableDatabases returns active writable database summaries", async () => {
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { tag: "identity" }, principal: "principal-1" }),
    createVfsActor: async () => ({
      async list_databases() {
        return {
          Ok: [
            rawDatabase("team-db", "Team Wiki", "Writer", "Active"),
            rawDatabase("reader-db", "Read Wiki", "Reader", "Active"),
            rawDatabase("old-db", "Old Wiki", "Owner", "Archived")
          ]
        };
      },
      async get_cycles_billing_config() {
        return {
          Ok: {
            kinic_ledger_canister_id: "ryjl3-tyaaa-aaaaa-aaaba-cai",
            billing_authority_id: "rrkah-fqaaa-aaaaa-aaaaq-cai",
            cycles_per_kinic: 1n,
            min_update_cycles: 10_000n
          }
        };
      }
    })
  });
  try {
    assert.deepEqual(await listWritableDatabases(config()), [
      {
        databaseId: "team-db",
        name: "Team Wiki",
        role: "Writer",
        status: "Active",
        logicalSizeBytes: "0",
        cyclesBalance: "20000",
        cyclesSuspendedAtMs: null,
        deletedAtMs: null,
        writeCyclesAvailable: true,
        cyclesReason: null
      }
    ]);
  } finally {
    setOffscreenDepsForTest();
  }
});

function evidenceSource() {
  return {
    path: "/Sources/chatgpt/abc.md",
    sourceId: "chatgpt-abc",
    content: "# ChatGPT",
    metadataJson: "{}"
  };
}

function config() {
  return {
    canisterId: "xis3j-paaaa-aaaai-axumq-cai",
    databaseId: "team-db",
    host: "https://icp0.io"
  };
}

function writeCyclesActorMethods({ databaseId = "team-db", balanceCycles = 20_000n, suspendedAtMs = null } = {}) {
  return {
    async list_databases() {
      return {
        Ok: [
          {
            database_id: databaseId,
            name: "Team DB",
            role: { Writer: null },
            status: { Active: null },
            logical_size_bytes: 0n,
            cycles_balance: [balanceCycles],
            cycles_suspended_at_ms: suspendedAtMs === null ? [] : [suspendedAtMs],
            archived_at_ms: [],
            deleted_at_ms: []
          }
        ]
      };
    },
    async get_cycles_billing_config() {
      return {
        Ok: {
          kinic_ledger_canister_id: "ryjl3-tyaaa-aaaaa-aaaba-cai",
          billing_authority_id: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          cycles_per_kinic: 1n,
          min_update_cycles: 10_000n
        }
      };
    }
  };
}

function rawDatabase(databaseId, name, role, status) {
  return {
    database_id: databaseId,
    name,
    role: { [role]: null },
    status: { [status]: null },
    logical_size_bytes: 0n,
    cycles_balance: [20_000n],
    cycles_suspended_at_ms: [],
    archived_at_ms: [],
    deleted_at_ms: []
  };
}
