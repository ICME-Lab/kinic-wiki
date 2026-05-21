// Where: extensions/wiki-clipper/tests/offscreen.test.mjs
// What: Unit tests for authenticated offscreen VFS writes.
// Why: Service workers delegate II-backed writes to offscreen documents.
import assert from "node:assert/strict";
import test from "node:test";
import { authStatus, queueUrlIngest, saveRawSource, setOffscreenDepsForTest } from "../src/offscreen.js";

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
        async read_node(databaseId, path) {
          calls.push(["read", databaseId, path]);
          return { Ok: [{ etag: "etag-1" }] };
        },
        async mkdir_node(request) {
          calls.push(["mkdir", request.database_id, request.path]);
          return { Ok: { created: true, path: request.path } };
        },
        async write_node(request) {
          calls.push(["write", request.database_id, request.path, request.expected_etag]);
          return { Ok: { created: false, node: { etag: "etag-2" } } };
        }
      };
    }
  });
  try {
    const result = await saveRawSource(rawSource(), config());

    assert.equal(result.etag, "etag-2");
    assert.equal(result.principal, "principal-1");
    assert.deepEqual(calls, [
      ["create", { tag: "identity" }, "team-db"],
      ["read", "team-db", "/Sources/raw/chatgpt-abc/chatgpt-abc.md"],
      ["mkdir", "team-db", "/Sources"],
      ["mkdir", "team-db", "/Sources/raw"],
      ["mkdir", "team-db", "/Sources/raw/chatgpt-abc"],
      ["write", "team-db", "/Sources/raw/chatgpt-abc/chatgpt-abc.md", ["etag-1"]]
    ]);
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

function rawSource() {
  return {
    path: "/Sources/raw/chatgpt-abc/chatgpt-abc.md",
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
