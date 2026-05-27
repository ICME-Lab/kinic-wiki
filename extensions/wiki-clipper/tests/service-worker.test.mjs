// Where: extensions/wiki-clipper/tests/service-worker.test.mjs
// What: Unit tests for DB-scoped canister writes from the service worker.
// Why: The capture extension must call the current canister API shape.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettingsContextMenuForTest,
  handleActionClick,
  handleContextMenuClickForTest,
  handleMessage,
  resetSettingsOpenThrottleForTest,
  resetUrlIngestInFlightForTest,
  setOffscreenBridgeForTest
} from "../src/service-worker.js";

test("save-source delegates raw source writes to offscreen", async () => {
  const syncStorage = memoryStorage();
  const restore = installChromeStorage(syncStorage);
  const calls = [];
  setOffscreenBridgeForTest(async (message) => {
    calls.push(message);
    if (message.type === "save-raw-source") {
      return {
        ok: true,
        result: {
          path: message.rawSource.path,
          sourceId: message.rawSource.sourceId,
          created: false,
          etag: "etag-2",
          sourceRunSessionNonce: "session-source"
        }
      };
    }
    return { ok: true, result: { sourcePath: message.sourcePath, triggered: true, triggerError: null } };
  });

  try {
    const response = await handleMessage(
      {
        type: "save-source",
        capture: capture(),
        config: { canisterId: "aaaaa-aa", databaseId: "team-db", host: "http://127.0.0.1:8001" }
      },
      sender()
    );

    assert.equal(response.ok, true);
    assert.equal(calls[0].type, "save-raw-source");
    assert.equal(calls[0].target, "offscreen");
    assert.equal(calls[0].config.databaseId, "team-db");
    assert.equal(calls[0].rawSource.path, "/Sources/raw/chatgpt/abc.md");
    assert.equal(calls[1].type, "trigger-source-generation");
    assert.equal(calls[1].sourcePath, "/Sources/raw/chatgpt/abc.md");
    assert.equal(calls[1].sourceEtag, "etag-2");
    assert.equal(calls[1].sessionNonce, "session-source");
    assert.equal(calls.length, 2);
    assert.equal(response.result.created, false);
    assert.equal(response.result.etag, "etag-2");
    assert.equal(response.result.generationQueued, true);
    assert.equal(response.result.generationError, null);
    assert.equal(syncStorage.getItem("databaseId"), null);
  } finally {
    setOffscreenBridgeForTest(null);
    restore();
  }
});

test("save-source keeps raw source result when generation queue fails", async () => {
  const restore = installChromeStorage(memoryStorage());
  setOffscreenBridgeForTest(async (message) => {
    if (message.type === "save-raw-source") {
      return {
        ok: true,
        result: {
          path: message.rawSource.path,
          sourceId: message.rawSource.sourceId,
          created: true,
          etag: "etag-1",
          sourceRunSessionNonce: "session-source"
        }
      };
    }
    return { ok: true, result: { sourcePath: message.sourcePath, triggered: false, triggerError: "worker trigger failed: HTTP 502" } };
  });

  try {
    const response = await handleMessage(
      {
        type: "save-source",
        capture: capture(),
        config: { canisterId: "aaaaa-aa", databaseId: "team-db", host: "http://127.0.0.1:8001" }
      },
      sender()
    );

    assert.equal(response.ok, true);
    assert.equal(response.result.path, "/Sources/raw/chatgpt/abc.md");
    assert.equal(response.result.etag, "etag-1");
    assert.equal(response.result.created, true);
    assert.equal(response.result.generationQueued, false);
    assert.equal(response.result.generationError, "worker trigger failed: HTTP 502");
  } finally {
    setOffscreenBridgeForTest(null);
    restore();
  }
});

test("save-source rejects missing database id", async () => {
  const restore = installChromeStorage(memoryStorage());
  try {
    await assert.rejects(
      () =>
        handleMessage(
          {
            type: "save-source",
            capture: capture(),
            config: { canisterId: "aaaaa-aa", databaseId: "", host: "http://127.0.0.1:8001" }
          },
          sender()
        ),
      /database id is required/
    );
  } finally {
    restore();
  }
});

test("auth-status delegates to offscreen without returning identity", async () => {
  const calls = [];
  setOffscreenBridgeForTest(async (message) => {
    calls.push(message);
    return { ok: true, result: { isAuthenticated: true, principal: "principal-1", identity: { secret: true } } };
  });
  try {
    const response = await handleMessage({ type: "auth-status" }, null);

    assert.deepEqual(calls, [{ target: "offscreen", type: "auth-status" }]);
    assert.deepEqual(response, { ok: true, result: { isAuthenticated: true, principal: "principal-1" } });
  } finally {
    setOffscreenBridgeForTest(null);
  }
});

test("auth-status opens settings when unauthenticated", async () => {
  const settingsTabs = [];
  resetSettingsOpenThrottleForTest();
  const restore = installChromeForSettings(memoryStorage(), settingsTabs);
  setOffscreenBridgeForTest(async () => ({ ok: true, result: { isAuthenticated: false, principal: null } }));
  try {
    const response = await handleMessage({ type: "auth-status" }, null);

    assert.deepEqual(response, { ok: true, result: { isAuthenticated: false, principal: null } });
    assert.deepEqual(settingsTabs, ["options"]);
  } finally {
    setOffscreenBridgeForTest(null);
    resetSettingsOpenThrottleForTest();
    restore();
  }
});

test("list-writable-databases delegates to offscreen with fixed runtime config", async () => {
  const syncStorage = memoryStorage();
  syncStorage.setItem("databaseId", "team-db");
  const restore = installChromeStorage(syncStorage);
  const calls = [];
  setOffscreenBridgeForTest(async (message) => {
    calls.push(message);
    return { ok: true, result: [{ databaseId: "team-db", name: "Team Wiki", role: "Writer", status: "Active" }] };
  });
  try {
    const response = await handleMessage({ type: "list-writable-databases" }, null);

    assert.equal(response.ok, true);
    assert.deepEqual(response.result, [{ databaseId: "team-db", name: "Team Wiki", role: "Writer", status: "Active" }]);
    assert.equal(calls[0].target, "offscreen");
    assert.equal(calls[0].type, "list-writable-databases");
    assert.equal(calls[0].config.databaseId, "team-db");
    assert.equal(calls[0].config.host, "https://icp0.io");
  } finally {
    setOffscreenBridgeForTest(null);
    restore();
  }
});

test("open-settings message opens settings once", async () => {
  const settingsTabs = [];
  resetSettingsOpenThrottleForTest();
  const restore = installChromeForSettings(memoryStorage(), settingsTabs);
  try {
    const first = await handleMessage({ type: "open-settings" }, null);
    const second = await handleMessage({ type: "open-settings" }, null);

    assert.deepEqual(first, { ok: true });
    assert.deepEqual(second, { ok: true });
    assert.deepEqual(settingsTabs, ["options"]);
  } finally {
    resetSettingsOpenThrottleForTest();
    restore();
  }
});

test("unauthenticated save-source opens settings once", async () => {
  const syncStorage = memoryStorage();
  const settingsTabs = [];
  resetSettingsOpenThrottleForTest();
  const restore = installChromeForSettings(syncStorage, settingsTabs);
  setOffscreenBridgeForTest(async () => ({ ok: false, error: "UNAUTHENTICATED" }));
  try {
    const message = {
      type: "save-source",
      capture: capture(),
      config: { canisterId: "aaaaa-aa", databaseId: "team-db", host: "http://127.0.0.1:8001" }
    };
    await assert.rejects(() => handleMessage(message, sender()), /UNAUTHENTICATED/);
    await assert.rejects(() => handleMessage(message, sender()), /UNAUTHENTICATED/);

    assert.deepEqual(settingsTabs, ["options"]);
  } finally {
    setOffscreenBridgeForTest(null);
    resetSettingsOpenThrottleForTest();
    restore();
  }
});

test("billing-disabled save-source opens settings once", async () => {
  const syncStorage = memoryStorage();
  const settingsTabs = [];
  resetSettingsOpenThrottleForTest();
  const restore = installChromeForSettings(syncStorage, settingsTabs);
  setOffscreenBridgeForTest(async () => ({ ok: false, error: "Database balance is below the minimum update balance." }));
  try {
    const message = {
      type: "save-source",
      capture: capture(),
      config: { canisterId: "aaaaa-aa", databaseId: "team-db", host: "http://127.0.0.1:8001" }
    };
    await assert.rejects(() => handleMessage(message, sender()), /minimum update balance/);
    await assert.rejects(() => handleMessage(message, sender()), /minimum update balance/);

    assert.deepEqual(settingsTabs, ["options"]);
  } finally {
    setOffscreenBridgeForTest(null);
    resetSettingsOpenThrottleForTest();
    restore();
  }
});

test("action click rejects non-http pages", async () => {
  const calls = [];
  const response = await handleActionClick(
    { url: "chrome://extensions", title: "Extensions" },
    actionDeps({
      writeStatus: async (status) => calls.push(["status", status.message]),
      setBadge: async (text) => calls.push(["badge", text])
    })
  );
  assert.equal(response.ok, false);
  assert.deepEqual(calls, [
    ["status", "URL must use http or https."],
    ["badge", "ERR"]
  ]);
});

test("action click opens settings when database config is incomplete", async () => {
  const calls = [];
  const response = await handleActionClick(
    { url: "https://example.com/", title: "Example" },
    actionDeps({
      loadConfig: async () => ({
        canisterId: "xis3j-paaaa-aaaai-axumq-cai",
        databaseId: "",
        host: "https://icp0.io"
      }),
      openSettings: async () => calls.push(["settings"]),
      writeStatus: async (status) => calls.push(["status", status.status, status.message]),
      setBadge: async (text) => calls.push(["badge", text])
    })
  );
  assert.equal(response.ok, false);
  assert.deepEqual(calls, [
    ["badge", "..."],
    ["status", "setup_required", "Login and select a writable database."],
    ["badge", "SET"],
    ["settings"]
  ]);
});

test("action click opens settings and stores status when billing is disabled", async () => {
  const calls = [];
  const response = await handleActionClick(
    { url: "https://example.com/", title: "Example" },
    actionDeps({
      sendOffscreen: async () => ({ ok: false, error: "Database billing is suspended." }),
      openSettings: async () => calls.push(["settings"]),
      writeStatus: async (status) => calls.push(["status", status.status, status.message]),
      setBadge: async (text) => calls.push(["badge", text])
    })
  );
  assert.equal(response.ok, false);
  assert.deepEqual(calls, [
    ["badge", "..."],
    ["status", "error", "Database billing is suspended."],
    ["badge", "ERR"],
    ["settings"]
  ]);
});

test("action click saves browser source then queues generation", async () => {
  const messages = [];
  const response = await handleActionClick(
    { url: "https://example.com/#section", title: "Example" },
    actionDeps({
      sendOffscreen: async (message) => {
        messages.push(message);
        if (message.type === "save-raw-source") {
          return {
            ok: true,
            result: { path: message.rawSource.path, created: true, etag: "etag-source", sourceRunSessionNonce: "session-source" }
          };
        }
        return { ok: true, result: { sourcePath: message.sourcePath, triggered: true } };
      }
    })
  );
  assert.equal(response.ok, true);
  assert.equal(messages[0].type, "save-raw-source");
  assert.equal(messages[0].rawSource.path, "/Sources/raw/web/abc.md");
  assert.equal(messages[0].config.databaseId, "team-db");
  assert.equal(messages[1].type, "trigger-source-generation");
  assert.equal(messages[1].sourcePath, "/Sources/raw/web/abc.md");
  assert.equal(messages[1].sourceEtag, "etag-source");
  assert.equal(messages[1].sessionNonce, "session-source");
  assert.equal(response.result.sourcePath, "/Sources/raw/web/abc.md");
  assert.equal(response.result.generationQueued, true);
});

test("action click keeps source result when generation trigger fails", async () => {
  const calls = [];
  const response = await handleActionClick(
    { url: "https://example.com/#section", title: "Example" },
    actionDeps({
      sendOffscreen: async (message) => {
        if (message.type === "save-raw-source") {
          return {
            ok: true,
            result: { path: message.rawSource.path, created: true, etag: "etag-source", sourceRunSessionNonce: "session-source" }
          };
        }
        return { ok: true, result: { sourcePath: message.sourcePath, triggered: false, triggerError: "worker trigger failed: HTTP 502" } };
      },
      writeStatus: async (status) => calls.push(["status", status.status, status.message]),
      setBadge: async (text) => calls.push(["badge", text])
    })
  );
  assert.equal(response.ok, true);
  assert.equal(response.result.sourcePath, "/Sources/raw/web/abc.md");
  assert.equal(response.result.generationQueued, false);
  assert.deepEqual(calls, [
    ["badge", "..."],
    ["status", "source_saved", "Source saved. Generation queue failed: worker trigger failed: HTTP 502"],
    ["badge", "SRC"]
  ]);
});

test("context menu opens settings without starting URL ingest", async () => {
  const createdMenus = [];
  let optionsOpened = 0;
  const restore = installChromeForContextMenu(createdMenus, () => {
    optionsOpened += 1;
  });
  try {
    await createSettingsContextMenuForTest();
    handleContextMenuClickForTest({ menuItemId: "kinic-wiki-clipper-settings" });

    assert.deepEqual(createdMenus, [{ id: "kinic-wiki-clipper-settings", title: "Settings", contexts: ["action"] }]);
    assert.equal(optionsOpened, 1);
  } finally {
    restore();
  }
});

test("action click rejects duplicate in-flight URL ingest", async () => {
  resetUrlIngestInFlightForTest();
  const deferred = createDeferred();
  const restore = installChromeForAction({
    sendOffscreen(message, callCount) {
      if (callCount === 1) return deferred.promise;
      if (message.type === "save-raw-source") {
        return {
          ok: true,
          result: { path: message.rawSource.path, created: true, etag: "etag-source", sourceRunSessionNonce: "session-source" }
        };
      }
      return { ok: true, result: { sourcePath: message.sourcePath, triggered: true } };
    }
  });
  try {
    const first = handleActionClick({ id: 1, url: "https://example.com/#section", title: "Example" });
    await waitUntil(() => restore.messages.length === 1);

    const duplicate = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error, "URL ingest is already running for this page.");
    assert.equal(restore.messages.length, 1);
    assert.ok(restore.badges.some((badge) => badge.text === "BUSY"));

    deferred.resolve({
      ok: true,
      result: { path: "/Sources/raw/web/abc.md", created: true, etag: "etag-source", sourceRunSessionNonce: "session-source" }
    });
    assert.equal((await first).ok, true);

    const retry = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(retry.ok, true);
    assert.equal(restore.messages.length, 4);
  } finally {
    resetUrlIngestInFlightForTest();
    restore();
  }
});

test("action click allows a different URL while another URL is in flight", async () => {
  resetUrlIngestInFlightForTest();
  const deferred = createDeferred();
  const restore = installChromeForAction({
    sendOffscreen(message, callCount) {
      if (callCount === 1) return deferred.promise;
      if (message.type === "save-raw-source") {
        return {
          ok: true,
          result: { path: message.rawSource.path, created: true, etag: "etag-source", sourceRunSessionNonce: "session-source" }
        };
      }
      return { ok: true, result: { sourcePath: message.sourcePath, triggered: true } };
    }
  });
  try {
    const first = handleActionClick({ id: 1, url: "https://example.com/a", title: "A" });
    await waitUntil(() => restore.messages.length === 1);

    const second = await handleActionClick({ id: 2, url: "https://example.com/b", title: "B" });
    assert.equal(second.ok, true);
    assert.equal(restore.messages.length, 3);
    assert.match(restore.messages[0].rawSource.path, /^\/Sources\/raw\/web\/[a-f0-9]{16}\.md$/);
    assert.match(restore.messages[1].rawSource.path, /^\/Sources\/raw\/web\/[a-f0-9]{16}\.md$/);
    assert.notEqual(restore.messages[0].rawSource.path, restore.messages[1].rawSource.path);

    deferred.resolve({
      ok: true,
      result: { path: "/Sources/raw/web/abc.md", created: true, etag: "etag-source", sourceRunSessionNonce: "session-source" }
    });
    assert.equal((await first).ok, true);
  } finally {
    resetUrlIngestInFlightForTest();
    restore();
  }
});

test("action click honors session in-flight TTL", async () => {
  resetUrlIngestInFlightForTest();
  const sessionStorage = memoryStorage();
  sessionStorage.setItem(
    "kinic-url-ingest-in-flight-v1",
    JSON.stringify({ key: "team-db:https://example.com/", expiresAt: Date.now() + 120_000 })
  );
  const restore = installChromeForAction({ sessionStorage });
  try {
    const busy = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(busy.ok, false);
    assert.equal(busy.error, "URL ingest is already running for this page.");
    assert.equal(restore.messages.length, 0);

    sessionStorage.setItem(
      "kinic-url-ingest-in-flight-v1",
      JSON.stringify({ key: "team-db:https://example.com/", expiresAt: Date.now() - 1 })
    );
    const response = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(response.ok, true);
    assert.equal(restore.messages.length, 2);
  } finally {
    resetUrlIngestInFlightForTest();
    restore();
  }
});

function capture() {
  return {
    provider: "chatgpt",
    url: "https://chatgpt.com/c/abc",
    capturedAt: "2026-05-01T00:00:00.000Z",
    conversationId: "abc",
    conversationTitle: "Project",
    messages: [{ role: "user", content: "Hello" }],
    captureMethod: "direct api"
  };
}

function sender() {
  return {
    tab: {
      url: "https://chatgpt.com/c/abc"
    }
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    entries() {
      return values.entries();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

function installChromeStorage(syncStorage) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        sync: {
          async get(defaults) {
            return { ...defaults, ...Object.fromEntries(syncStorage.entries()) };
          },
          async set(values) {
            for (const [key, value] of Object.entries(values)) {
              syncStorage.setItem(key, value);
            }
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              syncStorage.removeItem(key);
            }
          }
        }
      }
    }
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "chrome", descriptor);
    else delete globalThis.chrome;
  };
}

function installChromeForSettings(syncStorage, settingsTabs) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        getURL(path) {
          return `chrome-extension://id/${path}`;
        },
        async openOptionsPage() {
          settingsTabs.push("options");
        }
      },
      storage: {
        sync: {
          async get(defaults) {
            return { ...defaults, ...Object.fromEntries(syncStorage.entries()) };
          },
          async set(values) {
            for (const [key, value] of Object.entries(values)) {
              syncStorage.setItem(key, value);
            }
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              syncStorage.removeItem(key);
            }
          }
        }
      }
    }
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "chrome", descriptor);
    else delete globalThis.chrome;
  };
}

function installChromeForContextMenu(createdMenus, onOpenOptions) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      contextMenus: {
        async remove() {},
        create(item) {
          createdMenus.push(item);
        }
      },
      runtime: {
        openOptionsPage: onOpenOptions
      }
    }
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "chrome", descriptor);
    else delete globalThis.chrome;
  };
}

function installChromeForAction({ databaseId = "team-db", sessionStorage = memoryStorage(), sendOffscreen } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const syncStorage = memoryStorage();
  syncStorage.setItem("databaseId", databaseId);
  const badges = [];
  const messages = [];
  let sendCount = 0;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      action: {
        async setBadgeText({ text }) {
          badges.push({ text });
        },
        async setBadgeBackgroundColor() {}
      },
      offscreen: {
        Reason: { DOM_PARSER: "DOM_PARSER" },
        async createDocument() {}
      },
      runtime: {
        getURL(path) {
          return `chrome-extension://id/${path}`;
        },
        async getContexts() {
          return [];
        },
        async sendMessage(message) {
          sendCount += 1;
          messages.push(message);
          if (sendOffscreen) return sendOffscreen(message, sendCount);
          if (message.type === "save-raw-source") {
            return {
              ok: true,
              result: { path: message.rawSource.path, created: true, etag: "etag-source", sourceRunSessionNonce: "session-source" }
            };
          }
          return { ok: true, result: { sourcePath: message.sourcePath, triggered: true } };
        },
        async openOptionsPage() {}
      },
      scripting: {
        async executeScript() {
          return [{ result: { url: "https://example.com/", title: "Example", text: "Page text" } }];
        }
      },
      storage: {
        sync: storageArea(syncStorage),
        session: storageArea(sessionStorage)
      }
    }
  });
  const restore = () => {
    if (descriptor) Object.defineProperty(globalThis, "chrome", descriptor);
    else delete globalThis.chrome;
  };
  restore.badges = badges;
  restore.messages = messages;
  return restore;
}

function storageArea(storage) {
  return {
    async get(defaults) {
      if (typeof defaults === "string") {
        return { [defaults]: storage.getItem(defaults) };
      }
      return { ...defaults, ...Object.fromEntries(storage.entries()) };
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) {
        storage.setItem(key, value);
      }
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        storage.removeItem(key);
      }
    }
  };
}

function actionDeps(overrides = {}) {
  return {
    loadConfig: async () => ({
      canisterId: "aaaaa-aa",
      databaseId: "team-db",
      host: "https://icp0.io"
    }),
    ensureOffscreen: async () => {},
    sendOffscreen: async (message) =>
      message.type === "save-raw-source"
        ? {
            ok: true,
            result: { path: message.rawSource.path, created: true, etag: "etag-source", sourceRunSessionNonce: "session-source" }
          }
        : { ok: true, result: { sourcePath: message.sourcePath, triggered: true } },
    writeStatus: async () => {},
    setBadge: async () => {},
    openSettings: async () => {},
    reserveUrlIngest: async () => true,
    releaseUrlIngest: async () => {},
    captureTabSource: async () => rawWebSource(),
    ...overrides
  };
}

function rawWebSource() {
  return {
    path: "/Sources/raw/web/abc.md",
    sourceId: "web-abc",
    content: "# Example",
    metadataJson: "{}"
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not met");
}
