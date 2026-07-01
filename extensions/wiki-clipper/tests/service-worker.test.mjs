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
  refreshTabBadgeForTest,
  resetSettingsOpenThrottleForTest,
  resetSourceCaptureInFlightForTest,
  setOffscreenBridgeForTest
} from "../src/service-worker.js";

test("save-source delegates evidence source writes to offscreen", async () => {
  const syncStorage = memoryStorage();
  const restore = installChromeStorage(syncStorage);
  const calls = [];
  setOffscreenBridgeForTest(async (message) => {
    calls.push(message);
    if (message.type === "save-evidence-source") {
      return {
        ok: true,
        result: {
          path: message.evidenceSource.path,
          sourceId: message.evidenceSource.sourceId,
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
    assert.equal(calls[0].type, "save-evidence-source");
    assert.equal(calls[0].target, "offscreen");
    assert.equal(calls[0].config.databaseId, "team-db");
    assert.match(calls[0].evidenceSource.path, /^\/Sources\/chatgpt\/project-[a-f0-9]{8}\.md$/);
    assert.equal(calls[1].type, "trigger-source-generation");
    assert.equal(calls[1].sourcePath, calls[0].evidenceSource.path);
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

test("save-source keeps evidence source result when generation queue fails", async () => {
  const restore = installChromeStorage(memoryStorage());
  setOffscreenBridgeForTest(async (message) => {
    if (message.type === "save-evidence-source") {
      return {
        ok: true,
        result: {
          path: message.evidenceSource.path,
          sourceId: message.evidenceSource.sourceId,
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
    assert.match(response.result.path, /^\/Sources\/chatgpt\/project-[a-f0-9]{8}\.md$/);
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

test("unauthenticated database list does not open settings", async () => {
  const settingsTabs = [];
  resetSettingsOpenThrottleForTest();
  const restore = installChromeForSettings(memoryStorage(), settingsTabs);
  setOffscreenBridgeForTest(async () => ({ ok: false, error: "UNAUTHENTICATED" }));
  try {
    await assert.rejects(() => handleMessage({ type: "list-writable-databases" }, null), /UNAUTHENTICATED/);

    assert.deepEqual(settingsTabs, []);
  } finally {
    setOffscreenBridgeForTest(null);
    resetSettingsOpenThrottleForTest();
    restore();
  }
});

test("auth-session-changed resets an existing offscreen auth client", async () => {
  const calls = [];
  const restore = installChromeForOffscreenReset(calls, true);
  try {
    const response = await handleMessage({ type: "auth-session-changed" }, null);

    assert.deepEqual(response, { ok: true, reset: true });
    assert.deepEqual(calls, [
      ["contexts", "chrome-extension://id/offscreen/offscreen.html"],
      ["message", { target: "offscreen", type: "reset-auth-client" }]
    ]);
  } finally {
    restore();
  }
});

test("auth-session-changed does not create a missing offscreen document", async () => {
  const calls = [];
  const restore = installChromeForOffscreenReset(calls, false);
  try {
    const response = await handleMessage({ type: "auth-session-changed" }, null);

    assert.deepEqual(response, { ok: true, reset: false });
    assert.deepEqual(calls, [["contexts", "chrome-extension://id/offscreen/offscreen.html"]]);
  } finally {
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

test("cycles-disabled save-source opens settings once", async () => {
  const syncStorage = memoryStorage();
  const settingsTabs = [];
  resetSettingsOpenThrottleForTest();
  const restore = installChromeForSettings(syncStorage, settingsTabs);
  setOffscreenBridgeForTest(async () => ({ ok: false, error: "Database cycles balance is below the minimum update balance." }));
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

test("action click opens settings and stores status when cycles is disabled", async () => {
  const calls = [];
  const response = await handleActionClick(
    { url: "https://example.com/", title: "Example" },
    actionDeps({
      sendOffscreen: async () => ({ ok: false, error: "Database cycles are suspended." }),
      openSettings: async () => calls.push(["settings"]),
      writeStatus: async (status) => calls.push(["status", status.status, status.message]),
      setBadge: async (text) => calls.push(["badge", text])
    })
  );
  assert.equal(response.ok, false);
  assert.deepEqual(calls, [
    ["badge", "..."],
    ["status", "error", "Database cycles are suspended."],
    ["badge", "ERR"],
    ["settings"]
  ]);
});

test("action click opens settings when source save is unauthenticated", async () => {
  const calls = [];
  const response = await handleActionClick(
    { url: "https://example.com/", title: "Example" },
    actionDeps({
      sendOffscreen: async () => ({ ok: false, error: "UNAUTHENTICATED" }),
      openSettings: async () => calls.push(["settings"]),
      writeStatus: async (status) => calls.push(["status", status.status, status.message]),
      setBadge: async (text) => calls.push(["badge", text])
    })
  );
  assert.equal(response.ok, false);
  assert.deepEqual(calls, [
    ["badge", "..."],
    ["status", "error", "UNAUTHENTICATED"],
    ["badge", "ERR"],
    ["settings"]
  ]);
});

test("action click saves browser source then queues generation", async () => {
  const messages = [];
  const badges = [];
  const statuses = [];
  const response = await handleActionClick(
    { id: 3, url: "https://example.com/#section", title: "Example" },
    actionDeps({
      sendOffscreen: async (message) => {
        messages.push(message);
        return message.type === "run-source-capture-task" ? { ok: true, result: { accepted: true, taskId: message.taskId } } : { ok: true, result: { sourcePath: message.sourcePath, triggered: true } };
      },
      writeStatus: async (status) => statuses.push(status),
      setBadge: async (text, _color, tabId) => badges.push({ text, tabId })
    })
  );
  assert.equal(response.ok, true);
  assert.equal(response.accepted, true);
  assert.equal(messages[0].type, "web-source-exists");
  assert.equal(messages[0].config.databaseId, "team-db");
  assert.equal(messages[1].type, "run-source-capture-task");
  assert.equal(messages[1].evidenceSource.path, rawWebSource().path);
  assert.equal(messages[1].config.databaseId, "team-db");
  assert.equal(messages[1].queueGeneration, true);
  assert.equal(response.result.sourcePath, rawWebSource().path);
  assert.equal(response.result.generationRequested, true);
  assert.equal(statuses[0].status, "generation_requested");
  assert.equal(statuses[0].message, "Source generation requested.");
  assert.deepEqual(badges, [
    { text: "...", tabId: 3 },
    { text: "IN", tabId: 3 }
  ]);
});

test("action click queues generation for existing browser source", async () => {
  const calls = [];
  const messages = [];
  const response = await handleActionClick(
    { id: 7, url: "https://example.com/#section", title: "Example" },
    actionDeps({
      findWebSource: async (_config, sourcePath) => {
        calls.push(["lookup", sourcePath]);
        return { exists: true, path: sourcePath, etag: "etag-old" };
      },
      sendOffscreen: async (message) => {
        messages.push(message);
        return { ok: true, result: { accepted: true, taskId: message.taskId } };
      },
      setBadge: async (text, _color, tabId) => calls.push(["badge", text, tabId])
    })
  );

  assert.equal(response.ok, true);
  assert.equal(response.accepted, true);
  assert.equal(response.result.sourceExists, true);
  assert.equal(response.result.generationRequested, true);
  assert.equal(messages[0].type, "run-source-capture-task");
  assert.equal(messages[0].sourceAlreadyExists, true);
  assert.equal(messages[0].queueGeneration, true);
  const lookupPath = calls.find((call) => call[0] === "lookup")?.[1];
  assert.equal(lookupPath, rawWebSource().path);
  assert.deepEqual(calls, [
    ["badge", "...", 7],
    ["lookup", lookupPath],
    ["badge", "IN", 7]
  ]);
});

test("action click skips write and generation for existing browser source when saving source only", async () => {
  const calls = [];
  const response = await handleActionClick(
    { id: 7, url: "https://example.com/#section", title: "Example" },
    actionDeps({
      findWebSource: async (_config, sourcePath) => {
        calls.push(["lookup", sourcePath]);
        return { exists: true, path: sourcePath, etag: "etag-source" };
      },
      sendOffscreen: async (message) => {
        calls.push(["message", message.type]);
        return { ok: true, result: { sourcePath: message.sourcePath, triggered: true } };
      },
      writeStatus: async (status) => calls.push(["status", status.status, status.sourcePath, status.etag, status.message]),
      setBadge: async (text, _color, tabId) => calls.push(["badge", text, tabId])
    }),
    { queueGeneration: false }
  );

  assert.equal(response.ok, true);
  assert.equal(response.result.sourceExists, true);
  assert.equal(response.result.sourceEtag, "etag-source");
  assert.equal(response.result.generationQueued, false);
  const lookupPath = calls.find((call) => call[0] === "lookup")?.[1];
  assert.equal(lookupPath, rawWebSource().path);
  assert.deepEqual(calls, [
    ["badge", "...", 7],
    ["lookup", lookupPath],
    ["status", "source_exists", lookupPath, "etag-source", "Source already saved."],
    ["badge", "IN", 7]
  ]);
});

test("action click reports generation requested before trigger completion", async () => {
  const calls = [];
  const response = await handleActionClick(
    { url: "https://example.com/#section", title: "Example" },
    actionDeps({
      sendOffscreen: async (message) => {
        return message.type === "run-source-capture-task" ? { ok: true, result: { accepted: true, taskId: message.taskId } } : { ok: true, result: { sourcePath: message.sourcePath, triggered: true } };
      },
      writeStatus: async (status) => calls.push(["status", status.status, status.message]),
      setBadge: async (text) => calls.push(["badge", text])
    })
  );
  assert.equal(response.ok, true);
  assert.equal(response.accepted, true);
  assert.equal(response.result.sourcePath, rawWebSource().path);
  assert.equal(response.result.generationRequested, true);
  assert.deepEqual(calls, [
    ["badge", "..."],
    ["status", "generation_requested", "Source generation requested."],
    ["badge", "IN"]
  ]);
});

test("context menu opens settings without starting source capture", async () => {
  const createdMenus = [];
  let optionsOpened = 0;
  const restore = installChromeForContextMenu(createdMenus, () => {
    optionsOpened += 1;
  });
  try {
    await createSettingsContextMenuForTest();
    await handleContextMenuClickForTest({ menuItemId: "kinic-wiki-clipper-settings" });

    assert.deepEqual(createdMenus, [
      { id: "kinic-wiki-clipper-create-wiki", title: "Save source and create page", contexts: ["action"] },
      { id: "kinic-wiki-clipper-save-evidence", title: "Save source only", contexts: ["action"] },
      { id: "kinic-wiki-clipper-settings", title: "Settings", contexts: ["action"] }
    ]);
    assert.equal(optionsOpened, 1);
  } finally {
    restore();
  }
});

test("action click can save browser source without queueing generation", async () => {
  const calls = [];
  const messages = [];
  const response = await handleActionClick(
    { url: "https://example.com/#section", title: "Example" },
    actionDeps({
      sendOffscreen: async (message) => {
        messages.push(message);
        if (message.type === "web-source-exists") {
          return { ok: true, result: { exists: false, path: message.sourcePath, etag: null } };
        }
        return { ok: true, result: { accepted: true, taskId: message.taskId } };
      },
      writeStatus: async (status) => calls.push(["status", status.status, status.message]),
      setBadge: async (text) => calls.push(["badge", text])
    }),
    { queueGeneration: false }
  );

  assert.equal(response.ok, true);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, "web-source-exists");
  assert.equal(messages[1].type, "run-source-capture-task");
  assert.equal(messages[1].queueGeneration, false);
  assert.equal(response.result.generationSkipped, true);
  assert.deepEqual(calls, [
    ["badge", "..."],
    ["status", "source_save_sent", "Source save sent."],
    ["badge", "SRC"]
  ]);
});

test("context menu source-only save skips generation trigger", async () => {
  resetSourceCaptureInFlightForTest();
  const restore = installChromeForAction();
  try {
    const response = await handleContextMenuClickForTest(
      { menuItemId: "kinic-wiki-clipper-save-evidence" },
      { id: 1, url: "https://example.com/", title: "Example" }
    );

    assert.equal(response, undefined);
    assert.equal(restore.messages.length, 2);
    assert.equal(restore.messages[0].type, "web-source-exists");
    assert.equal(restore.messages[1].type, "run-source-capture-task");
    assert.equal(restore.messages[1].queueGeneration, false);
    assert.ok(restore.badges.some((badge) => badge.text === "SRC"));
  } finally {
    resetSourceCaptureInFlightForTest();
    restore();
  }
});

test("action click rejects duplicate in-flight source capture", async () => {
  resetSourceCaptureInFlightForTest();
  const restore = installChromeForAction();
  try {
    const first = await handleActionClick({ id: 1, url: "https://example.com/#section", title: "Example" });
    assert.equal(first.ok, true);
    await waitUntil(() => restore.messages.length === 2);

    const duplicate = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error, "Source capture is already running for this page.");
    assert.equal(restore.messages.length, 2);
    assert.ok(restore.badges.some((badge) => badge.text === "BUSY"));

    await completeSourceCaptureTask(restore.messages[1]);

    const retry = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(retry.ok, true);
    assert.equal(restore.messages.length, 4);
  } finally {
    resetSourceCaptureInFlightForTest();
    restore();
  }
});

test("source capture task failure stores URL error status and releases lock", async () => {
  resetSourceCaptureInFlightForTest();
  const restore = installChromeForAction();
  try {
    const first = await handleActionClick({ id: 1, url: "https://example.com/#section", title: "Example" });
    assert.equal(first.ok, true);
    const task = restore.messages[1];

    const result = await handleMessage(
      {
        type: "source-capture-task-result",
        taskId: task.taskId,
        inFlightKey: task.inFlightKey,
        tabId: task.tabId,
        ok: false,
        url: task.url,
        error: "worker trigger failed: HTTP 502"
      },
      { url: "chrome-extension://id/offscreen/offscreen.html" }
    );

    assert.equal(result.ok, true);
    const latest = JSON.parse(restore.sessionStorage.getItem("kinic-source-capture-status-v1"));
    assert.equal(latest.status, "error");
    assert.equal(latest.url, "https://example.com/");
    assert.equal(latest.message, "worker trigger failed: HTTP 502");
    assert.ok(restore.badges.some((badge) => badge.text === "ERR"));

    const retry = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(retry.ok, true);
  } finally {
    resetSourceCaptureInFlightForTest();
    restore();
  }
});

test("source capture reservation recovers after accepted task TTL expires without result", async () => {
  resetSourceCaptureInFlightForTest();
  const sessionStorage = memoryStorage();
  const restore = installChromeForAction({ sessionStorage });
  const originalNow = Date.now;
  try {
    const first = await handleActionClick({ id: 1, url: "https://example.com/#section", title: "Example" });
    assert.equal(first.ok, true);
    const task = restore.messages[1];
    const futureNow = originalNow() + 121_000;
    Date.now = () => futureNow;

    const retry = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(retry.ok, true);
    assert.equal(restore.messages.length, 4);
    assert.equal(restore.messages[3].type, "run-source-capture-task");
    assert.notEqual(restore.messages[3].taskId, task.taskId);
  } finally {
    Date.now = originalNow;
    resetSourceCaptureInFlightForTest();
    restore();
  }
});

test("source capture reservation recovers when session in-flight record is missing", async () => {
  resetSourceCaptureInFlightForTest();
  const sessionStorage = memoryStorage();
  const restore = installChromeForAction({ sessionStorage });
  try {
    const first = await handleActionClick({ id: 1, url: "https://example.com/#section", title: "Example" });
    assert.equal(first.ok, true);
    const task = restore.messages[1];
    sessionStorage.removeItem("kinic-source-capture-in-flight-v1");

    const retry = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(retry.ok, true);
    assert.equal(restore.messages.length, 4);
    assert.equal(restore.messages[3].type, "run-source-capture-task");
    assert.notEqual(restore.messages[3].taskId, task.taskId);
  } finally {
    resetSourceCaptureInFlightForTest();
    restore();
  }
});

test("source capture task result ignores spoofed senders", async () => {
  resetSourceCaptureInFlightForTest();
  const restore = installChromeForAction();
  try {
    const first = await handleActionClick({ id: 1, url: "https://example.com/#section", title: "Example" });
    assert.equal(first.ok, true);
    const task = restore.messages[1];

    const spoofed = await handleMessage(
      {
        type: "source-capture-task-result",
        taskId: task.taskId,
        inFlightKey: task.inFlightKey,
        tabId: task.tabId,
        ok: false,
        url: task.url,
        error: "spoofed"
      },
      { url: "chrome-extension://id/popup/popup.html" }
    );
    assert.deepEqual(spoofed, { ok: true, result: { accepted: false, ignored: true, reason: "untrusted sender" } });

    const duplicate = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error, "Source capture is already running for this page.");

    await completeSourceCaptureTask(task);
  } finally {
    resetSourceCaptureInFlightForTest();
    restore();
  }
});

test("source capture task result ignores stale task ids for the same URL", async () => {
  resetSourceCaptureInFlightForTest();
  const sessionStorage = memoryStorage();
  const restore = installChromeForAction({ sessionStorage });
  try {
    const first = await handleActionClick({ id: 1, url: "https://example.com/#section", title: "Example" });
    assert.equal(first.ok, true);
    const staleTask = restore.messages[1];
    sessionStorage.setItem(
      "kinic-source-capture-in-flight-v1",
      JSON.stringify({ key: staleTask.inFlightKey, taskId: staleTask.taskId, expiresAt: Date.now() - 1 })
    );
    resetSourceCaptureInFlightForTest();

    const second = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(second.ok, true);
    const activeTask = restore.messages[3];

    const stale = await completeSourceCaptureTask(staleTask);
    assert.deepEqual(stale, { ok: true, result: { accepted: false, ignored: true, reason: "stale task result" } });

    const duplicate = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error, "Source capture is already running for this page.");

    const active = await completeSourceCaptureTask(activeTask);
    assert.deepEqual(active, { ok: true, result: { accepted: true, status: "ok" } });

    const retry = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(retry.ok, true);
  } finally {
    resetSourceCaptureInFlightForTest();
    restore();
  }
});

test("action click reserves URL before delayed session storage read", async () => {
  resetSourceCaptureInFlightForTest();
  const sessionStorage = memoryStorage();
  const storageRead = createDeferred();
  let getCalls = 0;
  const sessionArea = {
    async get(defaults) {
      getCalls += 1;
      await storageRead.promise;
      if (typeof defaults === "string") {
        return { [defaults]: sessionStorage.getItem(defaults) };
      }
      return { ...defaults, ...Object.fromEntries(sessionStorage.entries()) };
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) {
        sessionStorage.setItem(key, value);
      }
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        sessionStorage.removeItem(key);
      }
    }
  };
  const restore = installChromeForAction({ sessionArea });
  try {
    const first = handleActionClick({ id: 1, url: "https://example.com/#section", title: "Example" });
    await waitUntil(() => getCalls === 1);

    const duplicate = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error, "Source capture is already running for this page.");

    storageRead.resolve();
    assert.equal((await first).ok, true);
    assert.equal(restore.messages.filter((message) => message.type === "run-source-capture-task").length, 1);
  } finally {
    resetSourceCaptureInFlightForTest();
    restore();
  }
});

test("action click rolls back URL reservation when session storage write fails", async () => {
  resetSourceCaptureInFlightForTest();
  const sessionStorage = memoryStorage();
  let failSet = true;
  const sessionArea = {
    async get(defaults) {
      if (typeof defaults === "string") {
        return { [defaults]: sessionStorage.getItem(defaults) };
      }
      return { ...defaults, ...Object.fromEntries(sessionStorage.entries()) };
    },
    async set(values) {
      if (failSet) {
        failSet = false;
        throw new Error("session write failed");
      }
      for (const [key, value] of Object.entries(values)) {
        sessionStorage.setItem(key, value);
      }
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        sessionStorage.removeItem(key);
      }
    }
  };
  const restore = installChromeForAction({ sessionArea });
  try {
    const failed = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "session write failed");

    const retry = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(retry.ok, true);
    assert.equal(restore.messages.filter((message) => message.type === "run-source-capture-task").length, 1);
  } finally {
    resetSourceCaptureInFlightForTest();
    restore();
  }
});

test("action click allows a different URL while another URL is in flight", async () => {
  resetSourceCaptureInFlightForTest();
  const restore = installChromeForAction();
  try {
    const first = await handleActionClick({ id: 1, url: "https://example.com/a", title: "A" });
    assert.equal(first.ok, true);
    await waitUntil(() => restore.messages.length === 2);

    const second = await handleActionClick({ id: 2, url: "https://example.com/b", title: "B" });
    assert.equal(second.ok, true);
    assert.equal(restore.messages.length, 4);
    assert.match(restore.messages[1].evidenceSource.path, /^\/Sources\/web\/example-[a-f0-9]{8}\.md$/);
    assert.match(restore.messages[3].evidenceSource.path, /^\/Sources\/web\/example-[a-f0-9]{8}\.md$/);
    assert.notEqual(restore.messages[1].evidenceSource.path, restore.messages[3].evidenceSource.path);
  } finally {
    resetSourceCaptureInFlightForTest();
    restore();
  }
});

test("action click honors session in-flight TTL", async () => {
  resetSourceCaptureInFlightForTest();
  const sessionStorage = memoryStorage();
  sessionStorage.setItem(
    "kinic-source-capture-in-flight-v1",
    JSON.stringify({ key: "team-db:https://example.com/", expiresAt: Date.now() + 120_000 })
  );
  const restore = installChromeForAction({ sessionStorage });
  try {
    const busy = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(busy.ok, false);
    assert.equal(busy.error, "Source capture is already running for this page.");
    assert.equal(restore.messages.length, 0);

    sessionStorage.setItem(
      "kinic-source-capture-in-flight-v1",
      JSON.stringify({ key: "team-db:https://example.com/", expiresAt: Date.now() - 1 })
    );
    const response = await handleActionClick({ id: 1, url: "https://example.com/", title: "Example" });
    assert.equal(response.ok, true);
    assert.equal(restore.messages.length, 2);
  } finally {
    resetSourceCaptureInFlightForTest();
    restore();
  }
});

test("tab badge refresh marks existing sources imported", async () => {
  const calls = [];
  const result = await refreshTabBadgeForTest(
    { id: 9, url: "https://example.com/post#section", title: "Example" },
    actionDeps({
      findWebSource: async (_config, sourcePath) => {
        calls.push(["lookup", sourcePath]);
        return { exists: true, path: sourcePath, etag: "etag-source" };
      },
      setBadge: async (text, _color, tabId) => calls.push(["badge", text, tabId])
    })
  );

  assert.equal(result.state, "source_exists");
  assert.deepEqual(calls, [
    ["lookup", result.sourcePath],
    ["badge", "IN", 9]
  ]);
});

test("tab badge refresh clears missing sources and unsupported pages", async () => {
  const calls = [];
  const missing = await refreshTabBadgeForTest(
    { id: 10, url: "https://example.com/post", title: "Example" },
    actionDeps({
      findWebSource: async (_config, sourcePath) => {
        calls.push(["lookup", sourcePath]);
        return { exists: false, path: sourcePath, etag: null };
      },
      setBadge: async (text, _color, tabId) => calls.push(["badge", text, tabId])
    })
  );
  const unsupported = await refreshTabBadgeForTest(
    { id: 11, url: "chrome://extensions" },
    actionDeps({
      findWebSource: async () => {
        calls.push(["unexpected lookup"]);
        return { exists: true, path: "/Sources/web/nope.md", etag: "etag" };
      },
      setBadge: async (text, _color, tabId) => calls.push(["badge", text, tabId])
    })
  );

  assert.equal(missing.state, "clear");
  assert.equal(unsupported.reason, "unsupported url");
  assert.deepEqual(calls, [
    ["lookup", missing.sourcePath],
    ["badge", "", 10],
    ["badge", "", 11]
  ]);
});

test("tab badge refresh clears without opening settings when config or auth is unavailable", async () => {
  const calls = [];
  const missingConfig = await refreshTabBadgeForTest(
    { id: 12, url: "https://example.com/post" },
    actionDeps({
      loadConfig: async () => ({ canisterId: "aaaaa-aa", databaseId: "", host: "https://icp0.io" }),
      openSettings: async () => calls.push(["settings"]),
      setBadge: async (text, _color, tabId) => calls.push(["badge", text, tabId])
    })
  );
  const authError = await refreshTabBadgeForTest(
    { id: 13, url: "https://example.com/post" },
    actionDeps({
      findWebSource: async () => {
        throw new Error("UNAUTHENTICATED");
      },
      openSettings: async () => calls.push(["settings"]),
      setBadge: async (text, _color, tabId) => calls.push(["badge", text, tabId])
    })
  );

  assert.equal(missingConfig.reason, "config required");
  assert.equal(authError.reason, "UNAUTHENTICATED");
  assert.deepEqual(calls, [
    ["badge", "", 12],
    ["badge", "", 13]
  ]);
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

function installChromeForOffscreenReset(calls, hasOffscreen) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        getURL(path) {
          return `chrome-extension://id/${path}`;
        },
        async getContexts(options) {
          calls.push(["contexts", options.documentUrls[0]]);
          return hasOffscreen ? [{ documentUrl: options.documentUrls[0] }] : [];
        },
        async sendMessage(message) {
          calls.push(["message", message]);
          return { ok: true, result: { reset: true } };
        }
      }
    }
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "chrome", descriptor);
    else delete globalThis.chrome;
  };
}

function installChromeForAction({ databaseId = "team-db", sessionStorage = memoryStorage(), sessionArea = null, sendOffscreen } = {}) {
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
        async setBadgeText({ text, tabId }) {
          badges.push({ text, tabId });
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
          if (message.type === "run-source-capture-task") {
            return {
              ok: true,
              result: { accepted: true, taskId: message.taskId }
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
        session: sessionArea || storageArea(sessionStorage)
      }
    }
  });
  const restore = () => {
    if (descriptor) Object.defineProperty(globalThis, "chrome", descriptor);
    else delete globalThis.chrome;
  };
  restore.badges = badges;
  restore.messages = messages;
  restore.sessionStorage = sessionStorage;
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
  const sendOffscreen =
    overrides.sendOffscreen ||
    (async (message) =>
      message.type === "run-source-capture-task"
        ? { ok: true, result: { accepted: true, taskId: message.taskId } }
        : { ok: true, result: { sourcePath: message.sourcePath, triggered: true } });
  return {
    loadConfig: async () => ({
      canisterId: "aaaaa-aa",
      databaseId: "team-db",
      host: "https://icp0.io"
    }),
    ensureOffscreen: async () => {},
    sendOffscreen,
    findWebSource: async (config, sourcePath) => {
      const response = await sendOffscreen({ target: "offscreen", type: "web-source-exists", sourcePath, config });
      if (!response?.ok) {
        throw new Error(response?.error || "source lookup failed");
      }
      return {
        exists: Boolean(response.result?.exists),
        path: response.result?.path || sourcePath,
        etag: response.result?.etag || null
      };
    },
    writeStatus: async () => {},
    setBadge: async () => {},
    openSettings: async () => {},
    reserveSourceCapture: async () => true,
    releaseSourceCapture: async () => {},
    captureTabSource: async () => rawWebSource(),
    ...overrides
  };
}

function rawWebSource() {
  return {
    path: "/Sources/web/example-1a2b3c4d.md",
    sourceId: "web-example-1a2b3c4d",
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

async function completeSourceCaptureTask(taskMessage, overrides = {}) {
  return handleMessage(
    {
      type: "source-capture-task-result",
      taskId: taskMessage.taskId,
      inFlightKey: taskMessage.inFlightKey,
      tabId: taskMessage.tabId,
      ok: true,
      result: {
        url: taskMessage.url,
        title: taskMessage.title,
        sourcePath: taskMessage.evidenceSource.path,
        sourceEtag: "etag-source",
        sourceExists: Boolean(taskMessage.sourceAlreadyExists),
        sourceCreated: true,
        generationQueued: taskMessage.queueGeneration !== false,
        generationSkipped: taskMessage.queueGeneration === false,
        generationError: null,
        ...overrides.result
      },
      ...overrides
    },
    { url: "chrome-extension://id/offscreen/offscreen.html" }
  );
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not met");
}
