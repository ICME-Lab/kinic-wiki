// Where: extensions/wiki-clipper/tests/recall-context.test.mjs
// What: Recall "Add context" fetch flow tests with stale-state revalidation.
// Why: A slow recall-fetch must never insert a stale memory into another conversation.
import assert from "node:assert/strict";
import test from "node:test";
import { applyRecallContext, isRecallContextStale } from "../src/recall-context.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function baseState(overrides = {}) {
  return {
    generation: 1,
    conversationUrl: "https://chatgpt.com/c/one",
    databaseId: "db-1",
    recallEnabled: true,
    ...overrides
  };
}

function run({ state = baseState(), request, send, format = () => "block" } = {}) {
  const captured = { messages: [] };
  const inserted = [];
  const pending = applyRecallContext({
    result: { path: "/Knowledge/mcp.md", snippet: "fallback" },
    request: request || { ...state },
    send: (message) => {
      captured.messages.push(message);
      return send;
    },
    state: () => state,
    format,
    insert: (text) => {
      inserted.push(text);
      return true;
    }
  });
  return { pending, inserted, captured };
}

test("isRecallContextStale detects every click-time state mismatch", () => {
  const request = baseState();
  assert.equal(isRecallContextStale(request, request), false);
  assert.equal(isRecallContextStale(request, baseState({ generation: 2 })), true);
  assert.equal(isRecallContextStale(request, baseState({ conversationUrl: "https://chatgpt.com/c/two" })), true);
  assert.equal(isRecallContextStale(request, baseState({ databaseId: "db-2" })), true);
  assert.equal(isRecallContextStale(request, baseState({ recallEnabled: false })), true);
});

test("applyRecallContext inserts when the click-time state is unchanged", async () => {
  const send = deferred();
  const state = baseState();
  const { pending, inserted, captured } = run({ state, send: send.promise });
  send.resolve({ ok: true, result: { content: "fetched body" } });
  const outcome = await pending;
  assert.equal(outcome.applied, true);
  assert.equal(outcome.reason, "inserted");
  assert.deepEqual(inserted, ["block"]);
  assert.deepEqual(captured.messages, [
    { type: "recall-fetch", requestId: "1", path: "/Knowledge/mcp.md" }
  ]);
});

test("applyRecallContext uses the fetched content when present", async () => {
  const send = deferred();
  const state = baseState();
  const { pending, inserted } = run({
    state,
    send: send.promise,
    format: (result, text) => `format:${text}`
  });
  send.resolve({ ok: true, result: { content: "fetched body" } });
  await pending;
  assert.deepEqual(inserted, ["format:fetched body"]);
});

test("applyRecallContext does not call send when already stale at click time", async () => {
  const send = deferred();
  send.promise.catch(() => {});
  const { pending, inserted, captured } = run({
    request: baseState({ generation: 1 }),
    state: baseState({ generation: 2 }),
    send: send.promise
  });
  send.reject(new Error("send must not be called"));
  const outcome = await pending;
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "stale");
  assert.deepEqual(captured.messages, []);
  assert.deepEqual(inserted, []);
});

test("applyRecallContext does not insert when generation changes during fetch", async () => {
  const send = deferred();
  const state = baseState();
  const { pending, inserted } = run({ state, send: send.promise });
  state.generation = 2;
  send.resolve({ ok: true, result: { content: "fetched body" } });
  const outcome = await pending;
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "stale");
  assert.deepEqual(inserted, []);
});

test("applyRecallContext does not insert when the conversation changes during fetch", async () => {
  const send = deferred();
  const state = baseState();
  const { pending, inserted } = run({ state, send: send.promise });
  state.conversationUrl = "https://chatgpt.com/c/two";
  send.resolve({ ok: true, result: { content: "fetched body" } });
  const outcome = await pending;
  assert.equal(outcome.reason, "stale");
  assert.deepEqual(inserted, []);
});

test("applyRecallContext does not insert when the database changes during fetch", async () => {
  const send = deferred();
  const state = baseState();
  const { pending, inserted } = run({ state, send: send.promise });
  state.databaseId = "db-2";
  send.resolve({ ok: true, result: { content: "fetched body" } });
  const outcome = await pending;
  assert.equal(outcome.reason, "stale");
  assert.deepEqual(inserted, []);
});

test("applyRecallContext does not insert when recall is disabled during fetch", async () => {
  const send = deferred();
  const state = baseState();
  const { pending, inserted } = run({ state, send: send.promise });
  state.recallEnabled = false;
  send.resolve({ ok: true, result: { content: "fetched body" } });
  const outcome = await pending;
  assert.equal(outcome.reason, "stale");
  assert.deepEqual(inserted, []);
});

test("applyRecallContext reports unavailable when the composer insert fails", async () => {
  const send = deferred();
  const state = baseState();
  const pending = applyRecallContext({
    result: { path: "/Knowledge/mcp.md", snippet: "fallback" },
    request: { ...state },
    send: () => send.promise,
    state: () => state,
    format: () => "block",
    insert: () => false
  });
  send.resolve({ ok: true, result: { content: "fetched body" } });
  const outcome = await pending;
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "unavailable");
});

test("applyRecallContext propagates fetch errors", async () => {
  const send = deferred();
  const state = baseState();
  const pending = applyRecallContext({
    result: { path: "/Knowledge/mcp.md", snippet: "fallback" },
    request: { ...state },
    send: () => send.promise,
    state: () => state,
    format: () => "block",
    insert: () => true
  });
  send.reject(new Error("recall fetch failed"));
  await assert.rejects(pending, /recall fetch failed/);
});