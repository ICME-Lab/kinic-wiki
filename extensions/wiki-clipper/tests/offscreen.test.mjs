// Where: extensions/wiki-clipper/tests/offscreen.test.mjs
// What: Unit tests for authenticated offscreen VFS writes.
// Why: Service workers delegate II-backed writes to offscreen documents.
import assert from "node:assert/strict";
import test from "node:test";
import {
  authStatus,
  handleOffscreenMessage,
  listWritableDatabases,
  queueUrlIngest,
  saveRawSource,
  setOffscreenDepsForTest,
  triggerSourceGeneration
} from "../src/offscreen.js";

test("queueUrlIngest writes request and triggers via wiki route", async () => {
  const calls = [];
  const triggerCalls = [];
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { tag: "identity" }, principal: "principal-1" }),
    fetch: async (url, init) => {
      triggerCalls.push([url, init]);
      return Response.json({ accepted: true });
    },
    createVfsActor: async (config) => {
      calls.push(["create", config.identity, config.databaseId]);
      return {
        ...writeCyclesActorMethods(),
        async authorize_url_ingest_trigger_session(request) {
          calls.push(["session", request.database_id, request.session_nonce]);
          return { Ok: null };
        },
        async mkdir_node(request) {
          calls.push(["mkdir", request.database_id, request.path]);
          return { Ok: { created: true, path: request.path } };
        },
        async write_node(request) {
          calls.push(["write", request.database_id, request.path, request.kind]);
          return { Ok: { created: true, node: { etag: "etag-request" } } };
        }
      };
    }
  });
  try {
    const result = await queueUrlIngest({ url: "https://example.com/#x", title: "Example" }, config());

    assert.equal(result.etag, "etag-request");
    assert.equal(result.principal, "principal-1");
    assert.equal(result.triggered, true);
    assert.equal(result.triggerError, null);
    assert.deepEqual(calls[0], ["create", { tag: "identity" }, "team-db"]);
    assert.equal(calls[1][0], "session");
    assert.equal(calls[1][1], "team-db");
    assert.equal(typeof calls[1][2], "string");
    assert.deepEqual(calls[2], ["mkdir", "team-db", "/Sources"]);
    assert.deepEqual(calls[3], ["mkdir", "team-db", "/Sources/ingest-requests"]);
    assert.equal(calls[4][0], "write");
    assert.equal(calls[4][1], "team-db");
    assert.match(calls[4][2], /^\/Sources\/ingest-requests\/.+\.md$/);
    assert.deepEqual(calls[4][3], { File: null });
    assert.equal(triggerCalls[0][0], "https://wiki.kinic.xyz/api/url-ingest/trigger");
    assert.equal(triggerCalls[0][1].method, "POST");
    assert.deepEqual(JSON.parse(triggerCalls[0][1].body), {
      canisterId: "xis3j-paaaa-aaaai-axumq-cai",
      databaseId: "team-db",
      requestPath: result.requestPath,
      sessionNonce: calls[1][2]
    });
  } finally {
    setOffscreenDepsForTest();
  }
});

test("queueUrlIngest keeps request result when trigger fails", async () => {
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { tag: "identity" }, principal: "principal-1" }),
    fetch: async () => new Response("nope", { status: 502 }),
    createVfsActor: async () => ({
      ...writeCyclesActorMethods(),
      async mkdir_node(request) {
        return { Ok: { created: true, path: request.path } };
      },
      async write_node() {
        return { Ok: { created: true, node: { etag: "etag-request" } } };
      },
      async authorize_url_ingest_trigger_session() {
        return { Ok: null };
      }
    })
  });
  try {
    const result = await queueUrlIngest({ url: "https://example.com/#x", title: "Example" }, config());

    assert.equal(result.etag, "etag-request");
    assert.equal(result.triggered, false);
    assert.equal(result.triggerError, "worker trigger failed: HTTP 502");
  } finally {
    setOffscreenDepsForTest();
  }
});

test("queueUrlIngest rejects before writing when session authorize fails", async () => {
  const triggerCalls = [];
  const calls = [];
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { tag: "identity" }, principal: "principal-1" }),
    fetch: async (url, init) => {
      triggerCalls.push([url, init]);
      return Response.json({ accepted: true });
    },
    createVfsActor: async () => ({
      ...writeCyclesActorMethods(),
      async write_node() {
        calls.push(["write"]);
        return { Ok: { created: true, node: { etag: "etag-request" } } };
      },
      async authorize_url_ingest_trigger_session() {
        calls.push(["session"]);
        return { Err: "caller mismatch" };
      }
    })
  });
  try {
    await assert.rejects(
      () => queueUrlIngest({ url: "https://example.com/#x", title: "Example" }, config()),
      /caller mismatch/
    );

    assert.deepEqual(calls, [["session"]]);
    assert.equal(triggerCalls.length, 0);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("queueUrlIngest reuses session nonce inside ttl", async () => {
  const triggerCalls = [];
  const calls = [];
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { tag: "identity" }, principal: "principal-1" }),
    fetch: async (url, init) => {
      triggerCalls.push([url, init]);
      return Response.json({ accepted: true });
    },
    createVfsActor: async () => ({
      ...writeCyclesActorMethods(),
      async authorize_url_ingest_trigger_session(request) {
        calls.push(["session", request.session_nonce]);
        return { Ok: null };
      },
      async mkdir_node(request) {
        calls.push(["mkdir", request.path]);
        return { Ok: { created: true, path: request.path } };
      },
      async write_node(request) {
        calls.push(["write", request.path]);
        return { Ok: { created: true, node: { etag: `etag-${calls.length}` } } };
      }
    })
  });
  try {
    await queueUrlIngest({ url: "https://example.com/a", title: "A" }, config());
    await queueUrlIngest({ url: "https://example.com/b", title: "B" }, config());

    const sessionCalls = calls.filter((call) => call[0] === "session");
    const writeCalls = calls.filter((call) => call[0] === "write");
    assert.equal(sessionCalls.length, 1);
    assert.equal(writeCalls.length, 2);
    assert.equal(triggerCalls.length, 2);
    assert.equal(JSON.parse(triggerCalls[0][1].body).sessionNonce, sessionCalls[0][1]);
    assert.equal(JSON.parse(triggerCalls[1][1].body).sessionNonce, sessionCalls[0][1]);
    assert.equal(JSON.parse(triggerCalls[0][1].body).canisterId, "xis3j-paaaa-aaaai-axumq-cai");
    assert.equal(JSON.parse(triggerCalls[1][1].body).canisterId, "xis3j-paaaa-aaaai-axumq-cai");
  } finally {
    setOffscreenDepsForTest();
  }
});

test("saveRawSource writes with authenticated identity", async () => {
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
    const result = await saveRawSource(rawSource(), config());

    assert.equal(result.etag, "etag-2");
    assert.equal(result.principal, "principal-1");
    assert.deepEqual(calls.slice(0, 5), [
      ["create", { tag: "identity" }, "team-db"],
      ["read", "team-db", "/Sources/raw/chatgpt/abc.md"],
      ["mkdir", "team-db", "/Sources"],
      ["mkdir", "team-db", "/Sources/raw"],
      ["mkdir", "team-db", "/Sources/raw/chatgpt"]
    ]);
    assert.equal(calls[5][0], "write");
    assert.equal(calls[5][1], "team-db");
    assert.equal(calls[5][2], "/Sources/raw/chatgpt/abc.md");
    assert.deepEqual(calls[5][3], ["etag-1"]);
    assert.equal(typeof calls[5][4], "string");
    assert.equal(result.sourceRunSessionNonce, calls[5][4]);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("saveRawSource rejects unauthenticated sessions", async () => {
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: false, identity: null, principal: null })
  });
  try {
    await assert.rejects(() => saveRawSource(rawSource(), config()), /UNAUTHENTICATED/);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("saveRawSource reloads auth client once before writing after a stale unauthenticated snapshot", async () => {
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
    const result = await saveRawSource(rawSource(), config());

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

test("queueUrlIngest rejects low cycle balance before writing", async () => {
  const calls = [];
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { tag: "identity" }, principal: "principal-1" }),
    createVfsActor: async () => ({
      ...writeCyclesActorMethods({ balanceCycles: 9_999n }),
      async authorize_url_ingest_trigger_session() {
        calls.push(["session"]);
        return { Ok: null };
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
    await assert.rejects(
      () => queueUrlIngest({ url: "https://example.com/#x", title: "Example" }, config()),
      /minimum update balance/
    );

    assert.deepEqual(calls, []);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("reset-auth-client message clears cached trigger sessions", async () => {
  const sessionNonces = [];
  setOffscreenDepsForTest({
    authSnapshot: async () => ({ isAuthenticated: true, identity: { tag: "identity" }, principal: "principal-1" }),
    createVfsActor: async () => ({
      ...writeCyclesActorMethods(),
      async authorize_url_ingest_trigger_session(request) {
        sessionNonces.push(request.session_nonce);
        return { Ok: null };
      },
      async mkdir_node(request) {
        return { Ok: { created: true, path: request.path } };
      },
      async write_node() {
        return { Ok: { created: true, node: { etag: "etag-request" } } };
      }
    }),
    fetch: async () => Response.json({ accepted: true })
  });
  try {
    await queueUrlIngest({ url: "https://example.com/a", title: "A" }, config());
    await queueUrlIngest({ url: "https://example.com/b", title: "B" }, config());
    await handleOffscreenMessage({ target: "offscreen", type: "reset-auth-client" });
    await queueUrlIngest({ url: "https://example.com/c", title: "C" }, config());

    assert.equal(sessionNonces.length, 2);
    assert.notEqual(sessionNonces[0], sessionNonces[1]);
  } finally {
    setOffscreenDepsForTest();
  }
});

test("saveRawSource rejects suspended cycles before writing", async () => {
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
    await assert.rejects(() => saveRawSource(rawSource(), config()), /cycles are suspended/);

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
    const result = await triggerSourceGeneration(config(), "/Sources/raw/web/abc.md", "etag-source", "session-source");

    assert.equal(result.triggered, true);
    assert.equal(result.sourcePath, "/Sources/raw/web/abc.md");
    assert.equal(result.sourceEtag, "etag-source");
    assert.equal(fetchCalls[0][0], "https://wiki.kinic.xyz/api/source/run");
    assert.deepEqual(JSON.parse(fetchCalls[0][1].body), {
      canisterId: "xis3j-paaaa-aaaai-axumq-cai",
      databaseId: "team-db",
      sourcePath: "/Sources/raw/web/abc.md",
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

function rawSource() {
  return {
    path: "/Sources/raw/chatgpt/abc.md",
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
