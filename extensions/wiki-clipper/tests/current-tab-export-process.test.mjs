// Where: extensions/wiki-clipper/tests/current-tab-export-process.test.mjs
// What: Unit tests for streaming export worker progress.
// Why: Parallel completions and cancellation must not corrupt UI state.
import assert from "node:assert/strict";
import test from "node:test";
import { createExportState, processExportTargets, readExportState, writeExportState } from "../src/current-tab-export.js";

test("processExportTargets records out-of-order worker completions without losing progress", async () => {
  const restore = installRuntimeStorage(memoryStorage());
  const originalFetch = globalThis.fetch;
  try {
    const state = exportingState(2);
    await writeExportState(state);
    globalThis.fetch = chatGptFetch(async (url) => {
      const id = String(url).split("/").pop();
      if (id === "slow") await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse(conversationPayload(id, id));
    });

    const states = [];
    const latest = await processExportTargets(
      [
        { id: "slow", title: "Slow", url: "https://chatgpt.com/c/slow" },
        { id: "fast", title: "Fast", url: "https://chatgpt.com/c/fast" }
      ],
      state,
      {
        onState(next) {
          states.push(next);
        },
        async send() {
          return { result: { path: "/Sources/raw/chatgpt-test/chatgpt-test.md", created: true } };
        }
      },
      2
    );

    assert.deepEqual(latest.progress, { total: 2, done: 2, ok: 2, failed: 0 });
    assert.equal(latest.logs.length, 2);
    assert.deepEqual(states.map((next) => next.progress.done), [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("processExportTargets serializes state writes that would otherwise lose progress", async () => {
  const restore = installRuntimeStorage(memoryStorage(), {
    async beforeSet(message) {
      const next = JSON.parse(message.value);
      if (next.progress?.done === 1) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
  });
  const originalFetch = globalThis.fetch;
  try {
    const state = exportingState(2);
    await writeExportState(state);
    globalThis.fetch = chatGptFetch(async (url) => jsonResponse(conversationPayload(String(url).split("/").pop(), "Title")));

    const latest = await processExportTargets(
      [
        { id: "one", title: "One", url: "https://chatgpt.com/c/one" },
        { id: "two", title: "Two", url: "https://chatgpt.com/c/two" }
      ],
      state,
      {
        async send(message) {
          if (message.capture.url.endsWith("/one")) {
            throw new Error("write failed");
          }
          return { result: { path: "/Sources/raw/chatgpt-two/chatgpt-two.md", created: true } };
        }
      },
      2
    );

    assert.deepEqual(latest.progress, { total: 2, done: 2, ok: 1, failed: 1 });
    assert.equal(latest.logs.length, 2);
    assert.equal(latest.logs.some((log) => log.kind === "error"), true);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("processExportTargets suppresses events completed after cancellation", async () => {
  const restore = installRuntimeStorage(memoryStorage());
  const originalFetch = globalThis.fetch;
  try {
    const state = exportingState(1);
    await writeExportState(state);
    globalThis.fetch = chatGptFetch(async () => jsonResponse(conversationPayload("cancelled", "Cancelled")));

    const latest = await processExportTargets(
      [{ id: "cancelled", title: "Cancelled", url: "https://chatgpt.com/c/cancelled" }],
      state,
      {
        async send() {
          await writeExportState({ ...state, status: "cancelled" });
          return { result: { path: "/Sources/raw/chatgpt-cancelled/chatgpt-cancelled.md", created: true } };
        }
      },
      1
    );

    assert.deepEqual(latest.progress, { total: 1, done: 0, ok: 0, failed: 0 });
    assert.equal(latest.logs.length, 0);
    assert.equal((await readExportState()).status, "cancelled");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("processExportTargets does not overwrite cancellation during progress write", async () => {
  const storage = memoryStorage();
  const restore = installRuntimeStorage(storage, {
    beforeSet(message) {
      const current = JSON.parse(storage.getItem(message.key) || "{}");
      if (current.status === "exporting" && JSON.parse(message.value).progress?.done === 1) {
        storage.setItem(message.key, JSON.stringify({ ...current, status: "cancelled" }));
      }
    }
  });
  const originalFetch = globalThis.fetch;
  try {
    const state = exportingState(1);
    await writeExportState(state);
    globalThis.fetch = chatGptFetch(async () => jsonResponse(conversationPayload("cancelled", "Cancelled")));

    const latest = await processExportTargets(
      [{ id: "cancelled", title: "Cancelled", url: "https://chatgpt.com/c/cancelled" }],
      state,
      {
        async send() {
          return { result: { path: "/Sources/raw/chatgpt-cancelled/chatgpt-cancelled.md", created: true } };
        }
      },
      1
    );

    assert.equal(latest.status, "cancelled");
    assert.deepEqual(latest.progress, { total: 1, done: 0, ok: 0, failed: 0 });
    assert.equal((await readExportState()).status, "cancelled");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("processExportTargets does not save after cancellation before save starts", async () => {
  const restore = installRuntimeStorage(memoryStorage());
  const originalFetch = globalThis.fetch;
  try {
    const state = exportingState(1);
    let saveCount = 0;
    await writeExportState(state);
    globalThis.fetch = chatGptFetch(async () => {
      await writeExportState({ ...state, status: "cancelled" });
      return jsonResponse(conversationPayload("cancelled", "Cancelled"));
    });

    const latest = await processExportTargets(
      [{ id: "cancelled", title: "Cancelled", url: "https://chatgpt.com/c/cancelled" }],
      state,
      {
        async send() {
          saveCount += 1;
          return { result: { path: "/Sources/raw/chatgpt-cancelled/chatgpt-cancelled.md", created: true } };
        }
      },
      1
    );

    assert.equal(saveCount, 0);
    assert.deepEqual(latest.progress, { total: 1, done: 0, ok: 0, failed: 0 });
    assert.equal(latest.logs.length, 0);
    assert.equal((await readExportState()).status, "cancelled");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

function exportingState(limit) {
  return {
    ...createExportState({ limit, config: {}, originalUrl: "https://chatgpt.com/" }),
    phase: "exporting",
    progress: { total: limit, done: 0, ok: 0, failed: 0 }
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    }
  };
}

function chatGptFetch(handler) {
  return async (url, init) => {
    if (url === "/api/auth/session") {
      return jsonResponse({ accessToken: "test-token" });
    }
    return handler(url, init);
  };
}

function conversationPayload(id, title) {
  return {
    conversation_id: id,
    title,
    current_node: "assistant1",
    mapping: {
      root: node(null, null),
      user1: node("root", message("user", "Hello")),
      assistant1: node("user1", message("assistant", "Hi"))
    }
  };
}

function node(parent, messageValue) {
  return { parent, children: [], message: messageValue };
}

function message(role, parts) {
  return {
    id: crypto.randomUUID(),
    author: { role },
    content: { parts: [parts] }
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

function installRuntimeStorage(storage, hooks = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        async sendMessage(message) {
          if (message.type === "export-state-get") {
            return { ok: true, value: storage.getItem(message.key) };
          }
          if (message.type === "export-state-set") {
            await hooks.beforeSet?.(message);
            if (JSON.parse(storage.getItem(message.key) || "{}").status === "cancelled") {
              return { ok: true };
            }
            storage.setItem(message.key, message.value);
            return { ok: true };
          }
          if (message.type === "export-state-remove") {
            storage.removeItem(message.key);
            return { ok: true };
          }
          return { ok: false, error: "unknown message type" };
        }
      }
    }
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "chrome", descriptor);
    else delete globalThis.chrome;
  };
}
