import assert from "node:assert/strict";
import test from "node:test";
import {
  DEEPSEEK_MODEL,
  DeepSeekResponseTooLargeError,
  readDeepSeekResponseText,
  requestDeepSeekCompletion,
} from "../index.js";

test("sends one authenticated POST without following redirects or rewriting the payload", async () => {
  const payload = JSON.stringify({ model: DEEPSEEK_MODEL, messages: [], tools: [], max_tokens: 1200 });
  const signal = new AbortController().signal;
  let calls = 0;
  const response = await requestDeepSeekCompletion({ apiKey: "test-key", body: payload, signal,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers.Authorization, "Bearer test-key");
      assert.equal(init.headers["Content-Type"], "application/json");
      assert.equal(init.body, payload);
      assert.equal(JSON.parse(init.body).model, "deepseek-flash");
      assert.equal(init.signal, signal);
      return new Response(null, { status: 307, headers: { location: "https://other.example/" } });
    },
  });
  assert.equal(response.status, 307);
  assert.equal(calls, 1);
});

test("preserves provider status and Retry-After without retrying", async () => {
  let calls = 0;
  const response = await requestDeepSeekCompletion({ apiKey: "test", body: "{}",
    fetchImpl: async () => { calls++; return new Response("busy", { status: 503, headers: { "retry-after": "30" } }); },
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal(await readDeepSeekResponseText(response), "busy");
  assert.equal(calls, 1);
});

test("preserves a network error without retrying", async () => {
  const error = new TypeError("network down");
  let calls = 0;
  await assert.rejects(requestDeepSeekCompletion({ apiKey: "test", body: "{}",
    fetchImpl: async () => { calls++; throw error; },
  }), (cause) => cause === error);
  assert.equal(calls, 1);
});

test("a cancelled request never reaches the provider", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(requestDeepSeekCompletion({ apiKey: "test", body: "{}", signal: controller.signal,
    fetchImpl: async () => { calls++; return Response.json({}); },
  }), (cause) => cause === reason);
  assert.equal(calls, 0);
});

test("decodes UTF-8 split across chunks and accepts the exact byte limit", async () => {
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([0xe6, 0x97]));
    controller.enqueue(new Uint8Array([0xa5, 0xe6, 0x9c, 0xac]));
    controller.close();
  } }));
  assert.equal(await readDeepSeekResponseText(response, 6), "日本");
  assert.equal(response.body.locked, false);
});

test("rejects declared oversized responses and cancels their body", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": "262145" } });
  await assert.rejects(readDeepSeekResponseText(response), DeepSeekResponseTooLargeError);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("enforces actual bytes even when Content-Length understates the response", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([0xe6, 0x97, 0xa5]));
    controller.enqueue(new Uint8Array([0xe6, 0x9c, 0xac]));
  }, cancel() { cancelled = true; } }), { headers: { "content-length": "1" } });
  await assert.rejects(readDeepSeekResponseText(response, 5), DeepSeekResponseTooLargeError);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("preserves stream failures and releases the reader", async () => {
  const error = new Error("body interrupted");
  const response = new Response(new ReadableStream({ start(controller) { controller.error(error); } }));
  await assert.rejects(readDeepSeekResponseText(response), (cause) => cause === error);
  assert.equal(response.body.locked, false);
});

test("returns empty text for a missing body", async () => {
  assert.equal(await readDeepSeekResponseText(new Response(null)), "");
});
