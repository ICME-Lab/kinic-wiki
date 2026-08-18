// Where: extensions/wiki-clipper/src/content-ui.tsx
// What: Inject export controls and opt-in Recall cards into supported AI chat pages.
// Why: Users can save explicitly and bring relevant Kinic memories back into ChatGPT.
import { computed, signal } from "@preact/signals";
import { render } from "preact";
import {
  cancelCurrentTabExport,
  isConversationLocation,
  providerFromLocation,
  providerLabel,
  resumeCurrentTabExport,
  startCurrentTabExport
} from "./current-tab-export.js";
import { DEFAULT_EXPORT_LIMIT, normalizeExportLimit } from "./history-links.js";
import { DEFAULT_CANISTER_ID, DEFAULT_IC_HOST } from "./source-capture-request.js";
import { databaseOptionLabel, isSelectedWritableDatabase } from "../popup/popup-state.js";
import { applyRecallStorageChanges, formatRecallContext } from "./recall.js";
import { applyRecallContext } from "./recall-context.js";
import {
  insertChatGptContext,
  installChatGptRecallListeners,
  installChatGptNavigationListener,
  isChatGptLocation
} from "./chatgpt-recall.js";

const ROOT_ID = "kinic-wiki-clipper-root";
const DEFAULT_DATABASE_ID = "";
const config = signal({ canisterId: DEFAULT_CANISTER_ID, databaseId: DEFAULT_DATABASE_ID, host: DEFAULT_IC_HOST });
const countText = signal(String(DEFAULT_EXPORT_LIMIT));
const status = signal("idle");
const error = signal("");
const toast = signal(null);
const panelOpen = signal(false);
const logs = signal([]);
const phase = signal("idle");
const progress = signal({ total: 0, done: 0, ok: 0, failed: 0 });
const databases = signal([]);
const databaseStatus = signal("loading");
const exportStartInFlight = signal(false);
const recallResults = signal([]);
const hasDatabaseConfig = computed(() => config.value.databaseId.trim().length > 0);
const selectedWritableDatabase = computed(() =>
  isSelectedWritableDatabase({
    databaseStatus: databaseStatus.value,
    databaseId: config.value.databaseId,
    databases: databases.value
  })
);
const exportLocked = computed(() => exportStartInFlight.value || status.value === "exporting");
const canExport = computed(() => !exportLocked.value && selectedWritableDatabase.value);
const exportProvider = computed(() => providerFromLocation(location) || "chatgpt");
const exportProviderLabel = computed(() => providerLabel(exportProvider.value));
const isGeminiProvider = computed(() => exportProvider.value === "gemini");
const logoUrl = chrome.runtime.getURL("icons/icon-32.png");
let resumeStarted = false;
let configLoadPromise = Promise.resolve();
let toastTimer = null;
let recallRequestGeneration = 0;

ensureMounted();
new MutationObserver(() => ensureMounted()).observe(document.documentElement, { childList: true, subtree: true });
installChatGptRecallListeners({
  documentRef: document,
  locationLike: location,
  onSubmit: (query) => runRecall(query)
});
installChatGptNavigationListener({
  windowRef: globalThis,
  locationLike: location,
  documentRef: document,
  MutationObserverRef: MutationObserver,
  onNavigate: () => invalidateRecall()
});
chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
  const previous = config.value;
  const next = applyRecallStorageChanges(previous, changes, areaName);
  const databaseChanged = next.databaseId !== previous.databaseId;
  const recallChanged = next.recallEnabled !== previous.recallEnabled;
  if (!databaseChanged && !recallChanged) return;
  config.value = { ...previous, ...next };
  if (databaseChanged || (recallChanged && !next.recallEnabled)) invalidateRecall();
});

function ensureMounted() {
  if (document.getElementById(ROOT_ID) || !document.body) return;
  const host = document.createElement("div");
  host.id = ROOT_ID;
  document.body.append(host);
  render(<App />, host.attachShadow({ mode: "open" }));
  configLoadPromise = loadConfig();
  resumeExport();
}

function App() {
  return (
    <>
      <style>{styles}</style>
      <div class="quick-actions">
        <button class="kinic-fab" type="button" disabled={exportLocked.value} onClick={quickSave}>
          <img class="kinic-logo" src={logoUrl} alt="" />
          <span>Save to Kinic</span>
        </button>
        <button class="quick-options" type="button" aria-label="Open save options" onClick={openPanel}>
          ⋯
        </button>
      </div>
      {toast.value ? <div class={`save-toast ${toast.value.kind}`} role="status" aria-live="polite">{toast.value.message}</div> : null}
      {!panelOpen.value && recallResults.value.length > 0 ? <RecallPanel /> : null}
      {panelOpen.value ? <Modal /> : null}
    </>
  );
}

function RecallPanel() {
  return (
    <section class="recall-panel" aria-label="Kinic Memory">
      <header class="recall-header">
        <strong>Kinic Memory</strong>
        <span>{recallResults.value.length} related</span>
      </header>
      <div class="recall-list">
        {recallResults.value.map((result) => <RecallCard key={result.path} result={result} />)}
      </div>
    </section>
  );
}

function RecallCard({ result }) {
  return (
    <article class="recall-card">
      <div class="recall-card-body">
        <strong>{result.title}</strong>
        <p>{result.snippet || result.path}</p>
        <small>{result.path}</small>
      </div>
      <button type="button" onClick={() => addRecallContext(result)}>Add context</button>
    </article>
  );
}

function Modal() {
  return (
    <section class="panel" aria-label="Kinic Wiki Clipper export">
      <header class="panel-header">
        <div class="brand">
          <img class="kinic-logo" src={logoUrl} alt="" />
          <div>
            <strong>Kinic Wiki Clipper</strong>
            <p>{isGeminiProvider.value ? "Export the current Gemini conversation into your knowledge store" : `Export ${exportProviderLabel.value} conversations into your knowledge store`}</p>
          </div>
        </div>
        <button class="close" type="button" aria-label="Close" onClick={() => (panelOpen.value = false)}>
          x
        </button>
      </header>
      <section class="settings">
        <div class="export-block">
          <label class="database-field">
            <span>Database</span>
            <select value={config.value.databaseId} disabled={exportLocked.value || databaseStatus.value !== "ready"} onChange={selectDatabase}>
              {databaseOptions()}
            </select>
          </label>
          {databaseStatus.value === "error" ? (
            <div class="setup-row">
              <p>Login and select a writable database.</p>
              <button type="button" onClick={openSettings}>
                Open settings
              </button>
            </div>
          ) : null}
          <strong>{isGeminiProvider.value ? "Export the current conversation" : "Export the recent chats"}</strong>
          {status.value === "exporting" ? (
            <p class="export-warning">Export is running. You can keep using this tab, but do not close it until it finishes.</p>
          ) : null}
          {!hasDatabaseConfig.value ? (
            <div class="setup-row">
              <p>Database is not selected.</p>
              <button type="button" onClick={openSettings}>
                Open settings
              </button>
            </div>
          ) : null}
          {isGeminiProvider.value ? (
            <div class="export-box">
              <p>Only the current rendered Gemini conversation is available for export.</p>
              <div class="export-control">
                <button type="button" disabled={!canExport.value} onClick={startExport}>Export current</button>
              </div>
            </div>
          ) : (
            <div class="export-box">
              <p>Processing takes ~10 seconds per chat. If you have over 50 chats, export manually to save time.</p>
              <div class="export-control">
                <input
                  inputMode="numeric"
                  value={countText.value}
                  onInput={(event) => (countText.value = event.currentTarget.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  onMouseUp={(event) => event.preventDefault()}
                  onBlur={() => (countText.value = String(normalizeExportLimit(countText.value)))}
                />
                <button type="button" disabled={!canExport.value} onClick={startExport}>
                  Export
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
      <section class="logs">
        <h2>Logs</h2>
        <div class="filter">All</div>
        <p class={`status ${error.value ? "error" : ""}`}>{statusText()}</p>
        {status.value === "exporting" ? (
          <button class="cancel" type="button" onClick={cancelExport}>
            Stop export
          </button>
        ) : null}
        <div class="log-list">{logs.value.map((log) => <LogItem key={log.id} log={log} />)}</div>
      </section>
    </section>
  );
}

function LogItem({ log }) {
  return (
    <article class={`log ${log.kind}`}>
      <span class="log-icon">K</span>
      <div>
        <div class="log-meta">
          <span>{log.time}</span>
          <span>{log.provider || "ChatGPT"}</span>
        </div>
        <p>{log.message}</p>
      </div>
    </article>
  );
}

async function startExport() {
  if (exportLocked.value) return;
  exportStartInFlight.value = true;
  error.value = "";
  logs.value = [];
  try {
    const nextConfig = normalizedConfig();
    const requestedDatabaseId = nextConfig.databaseId;
    await refreshDatabases({ repairSelection: false });
    const requestedWritableDatabase = isSelectedWritableDatabase({
      databaseStatus: databaseStatus.value,
      databaseId: requestedDatabaseId,
      databases: databases.value
    });
    if (!requestedDatabaseId || !requestedWritableDatabase) {
      error.value = "Select a writable database in settings.";
      status.value = "idle";
      await openSettings();
      return;
    }
    const limit = isGeminiProvider.value ? 1 : normalizeExportLimit(countText.value);
    if (!isGeminiProvider.value) countText.value = String(limit);
    status.value = "exporting";
    phase.value = "fetching";
    progress.value = { total: limit, done: 0, ok: 0, failed: 0 };
    await startCurrentTabExport({
      limit,
      config: nextConfig,
      provider: exportProvider.value,
      originalUrl: location.href,
      callbacks: exportCallbacks()
    });
  } catch (nextError) {
    error.value = messageForError(nextError);
    status.value = "error";
  } finally {
    exportStartInFlight.value = false;
  }
}

async function quickSave() {
  if (exportLocked.value) return;
  if (!isConversationLocation(location)) {
    showToast("Open a conversation to save.", "error");
    return;
  }
  exportStartInFlight.value = true;
  error.value = "";
  try {
    await configLoadPromise;
    const nextConfig = normalizedConfig();
    const requestedDatabaseId = nextConfig.databaseId;
    await refreshDatabases({ repairSelection: false });
    const requestedWritableDatabase = isSelectedWritableDatabase({
      databaseStatus: databaseStatus.value,
      databaseId: requestedDatabaseId,
      databases: databases.value
    });
    if (!requestedDatabaseId || !requestedWritableDatabase) {
      showToast("Select a writable database in settings.", "error");
      await openSettings();
      return;
    }
    status.value = "exporting";
    phase.value = "fetching";
    progress.value = { total: 1, done: 0, ok: 0, failed: 0 };
    await startCurrentTabExport({
      limit: 1,
      config: nextConfig,
      provider: exportProvider.value,
      originalUrl: location.href,
      callbacks: quickExportCallbacks()
    });
  } catch (nextError) {
    error.value = messageForError(nextError);
    status.value = "error";
    showToast(error.value, "error");
  } finally {
    exportStartInFlight.value = false;
  }
}

async function cancelExport() {
  await cancelCurrentTabExport(exportCallbacks());
}

async function openSettings() {
  await send({ type: "open-settings" });
}

async function runRecall(query) {
  if (!isChatGptLocation(location)) return;
  await configLoadPromise;
  if (!config.value.recallEnabled) return;
  const generation = ++recallRequestGeneration;
  recallResults.value = [];
  try {
    const response = await send({
      type: "recall-search",
      requestId: String(generation),
      provider: "chatgpt",
      query,
      conversationUrl: location.href
    });
    if (generation !== recallRequestGeneration) return;
    recallResults.value = Array.isArray(response.result) ? response.result : [];
  } catch {
    if (generation === recallRequestGeneration) recallResults.value = [];
  }
}

function invalidateRecall() {
  recallRequestGeneration += 1;
  recallResults.value = [];
}

async function addRecallContext(result) {
  try {
    const outcome = await applyRecallContext({
      result,
      request: recallState(),
      send,
      state: recallState,
      format: formatRecallContext,
      insert: (context) => insertChatGptContext(context, document)
    });
    if (outcome.reason === "stale") return;
    if (!outcome.applied) {
      showToast("ChatGPT input is unavailable.", "error");
      return;
    }
    showToast("Kinic memory added to the input.", "success");
  } catch (nextError) {
    showToast(messageForError(nextError), "error");
  }
}

function recallState() {
  return {
    generation: recallRequestGeneration,
    conversationUrl: location.href,
    databaseId: config.value.databaseId,
    recallEnabled: config.value.recallEnabled === true
  };
}

async function loadConfig() {
  try {
    const response = await send({ type: "load-config" });
    config.value = configWithDefaults(response.config);
  } catch (nextError) {
    error.value = messageForError(nextError);
  }
}

async function openPanel() {
  panelOpen.value = true;
  await refreshDatabases();
}

async function refreshDatabases({ repairSelection = true } = {}) {
  try {
    databaseStatus.value = "loading";
    await configLoadPromise;
    const response = await send({ type: "list-writable-databases" });
    const selectableDatabases = (response.result || []).filter((database) => database.writeCyclesAvailable !== false);
    databases.value = selectableDatabases;
    databaseStatus.value = databases.value.length > 0 ? "ready" : "empty";
    if (!repairSelection) return;
    if (databases.value.length === 0) {
      if (config.value.databaseId) await saveDatabase("");
      return;
    }
    if (!databases.value.some((database) => database.databaseId === config.value.databaseId)) {
      await saveDatabase(databases.value[0].databaseId);
    }
  } catch (nextError) {
    databases.value = [];
    error.value = messageForError(nextError);
    databaseStatus.value = "error";
  }
}

async function selectDatabase(event) {
  await saveDatabase(event.currentTarget.value);
}

async function saveDatabase(databaseId) {
  await send({ type: "save-config", config: { databaseId } });
  config.value = { ...config.value, databaseId };
}

function databaseOptions() {
  if (databases.value.length === 0) {
    return <option value="">No writable databases</option>;
  }
  const counts = databaseNameCounts(databases.value);
  return databases.value.map((database) => (
    <option key={database.databaseId} value={database.databaseId} title={database.databaseId}>
      {databaseOptionLabel(database, counts.get(databaseNameKey(database.name)) || 1)}
    </option>
  ));
}

function databaseNameCounts(values) {
  const counts = new Map();
  for (const database of values) {
    const key = databaseNameKey(database.name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function databaseNameKey(name) {
  return String(name || "").trim().toLowerCase();
}

function configWithDefaults(value) {
  return {
    canisterId: String(value?.canisterId || DEFAULT_CANISTER_ID),
    databaseId: String(value?.databaseId || DEFAULT_DATABASE_ID),
    host: DEFAULT_IC_HOST,
    recallEnabled: value?.recallEnabled === true || value?.recallEnabled === "true"
  };
}

function normalizedConfig() {
  return {
    canisterId: DEFAULT_CANISTER_ID,
    databaseId: config.value.databaseId.trim(),
    host: DEFAULT_IC_HOST,
    recallEnabled: config.value.recallEnabled === true
  };
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "extension request failed");
  return response;
}

function resumeExport() {
  if (resumeStarted) return;
  resumeStarted = true;
  resumeCurrentTabExport(exportCallbacks()).catch((nextError) => {
    error.value = messageForError(nextError);
    status.value = "error";
  });
}

function exportCallbacks() {
  return {
    send,
    onState(nextState) {
      panelOpen.value = true;
      config.value = configWithDefaults(nextState.config || config.value);
      progress.value = nextState.progress;
      logs.value = nextState.logs || [];
      status.value = nextState.status;
      phase.value = nextState.phase || phase.value;
      error.value = nextState.error || "";
    }
  };
}

function quickExportCallbacks() {
  return {
    send,
    onState(nextState) {
      config.value = configWithDefaults(nextState.config || config.value);
      progress.value = nextState.progress;
      logs.value = nextState.logs || [];
      status.value = nextState.status;
      phase.value = nextState.phase || phase.value;
      error.value = nextState.error || "";
      if (nextState.status === "done") {
        showToast(quickSaveResultMessage(nextState), "success");
      } else if (["error", "partial", "cancelled"].includes(nextState.status)) {
        showToast(nextState.error || "Could not save to Kinic.", "error");
      }
    }
  };
}

function quickSaveResultMessage(state) {
  const latestMessage = state.logs?.[0]?.message || "";
  return latestMessage.includes("(Updated)") ? "Already saved to Kinic." : "Saved to Kinic.";
}

function showToast(message, kind = "info") {
  if (toastTimer) clearTimeout(toastTimer);
  toast.value = { message, kind };
  toastTimer = setTimeout(() => {
    toast.value = null;
    toastTimer = null;
  }, 4000);
}

function statusText() {
  if (error.value) return error.value;
  const value = progress.value;
  if (status.value === "idle") return "Ready";
  if (status.value === "exporting" && phase.value === "fetching") return `Fetching conversations... 0/${value.total}.`;
  if (status.value === "exporting") return `Exporting sources ${value.done}/${value.total}. Success ${value.ok}, failed ${value.failed}.`;
  if (status.value === "done") return `Export complete. Success ${value.ok}.`;
  if (status.value === "partial") return `Export complete with errors. Success ${value.ok}, failed ${value.failed}.`;
  if (status.value === "cancelled") return `Export cancelled. Success ${value.ok}, failed ${value.failed}.`;
  return "Ready";
}

function messageForError(value) {
  return value instanceof Error ? value.message : String(value);
}

const styles = `
:host{all:initial;--kinic-white:#ffffff;--kinic-paper:#f8f8f8;--kinic-ink:#000000;--kinic-body:#636161;--kinic-support:#4d4d4d;--kinic-line:#e6e6e6;--kinic-mid-line:#d0d0d0;--kinic-hot-pink:#ff2686;--kinic-pale-pink:#ffcde5;--kinic-soft-pink:#ff81be26;--kinic-success:#11845b;--kinic-success-soft:#def2e6;--kinic-error:#dc2b2b;--kinic-error-soft:#ffeff0;color-scheme:light;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}
.quick-actions{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;align-items:center;gap:6px}.kinic-fab{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--kinic-ink);border-radius:999px;padding:9px 14px;background:var(--kinic-ink);color:var(--kinic-white);font:700 13px/1 system-ui;box-shadow:0 4px 10px #14142b0a;transition:background .3s ease,border-color .3s ease,transform .3s ease,color .3s ease}
.kinic-fab:hover{border-color:var(--kinic-hot-pink);background:var(--kinic-hot-pink);transform:translateY(-3px)}
.kinic-fab:focus-visible{outline:2px solid var(--kinic-soft-pink);outline-offset:2px}
.quick-options{display:grid;place-items:center;width:34px;height:34px;border:1px solid var(--kinic-ink);border-radius:50%;background:var(--kinic-white);color:var(--kinic-ink);font:800 20px/1 system-ui;box-shadow:0 4px 10px #14142b0a;transition:background .3s ease,border-color .3s ease,color .3s ease,transform .3s ease}.quick-options:hover{border-color:var(--kinic-hot-pink);background:var(--kinic-hot-pink);color:var(--kinic-white);transform:translateY(-3px)}.quick-options:focus-visible{outline:2px solid var(--kinic-soft-pink);outline-offset:2px}
.save-toast{position:fixed;right:18px;bottom:68px;z-index:2147483647;border:1px solid var(--kinic-line);border-radius:12px;padding:9px 12px;background:var(--kinic-white);color:var(--kinic-ink);font:700 13px/1.3 system-ui;box-shadow:0 8px 24px rgb(0 0 0 / 14%)}.save-toast.error{border-color:var(--kinic-pale-pink);background:var(--kinic-soft-pink);color:var(--kinic-hot-pink)}
.recall-panel{position:fixed;right:18px;bottom:74px;z-index:2147483646;width:min(420px,calc(100vw - 36px));max-height:min(420px,calc(100vh - 110px));overflow:auto;border:1px solid var(--kinic-line);border-radius:16px;background:var(--kinic-white);color:var(--kinic-ink);box-shadow:0 18px 44px rgb(0 0 0 / 16%);font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.recall-header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--kinic-line);padding:12px 14px}.recall-header span{color:var(--kinic-body);font-size:11px;font-weight:700}.recall-list{display:grid;gap:8px;padding:10px}.recall-card{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;border:1px solid var(--kinic-line);border-radius:12px;padding:10px;background:var(--kinic-paper)}.recall-card-body{min-width:0}.recall-card strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.recall-card p{display:-webkit-box;overflow:hidden;margin:4px 0;color:var(--kinic-support);font-size:12px;-webkit-box-orient:vertical;-webkit-line-clamp:3}.recall-card small{display:block;overflow:hidden;color:var(--kinic-body);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.recall-card button{border:1px solid var(--kinic-ink);border-radius:10px;padding:7px 9px;background:var(--kinic-ink);color:var(--kinic-white);font-size:11px;font-weight:800;white-space:nowrap}.recall-card button:hover{border-color:var(--kinic-hot-pink);background:var(--kinic-hot-pink)}
.kinic-logo{display:block;flex:0 0 auto;width:24px;height:24px;border-radius:8px;object-fit:cover}
.panel{position:fixed;right:18px;bottom:62px;z-index:2147483647;width:min(672px,calc(100vw - 32px));max-height:min(650px,calc(100vh - 86px));overflow:hidden;border:1px solid var(--kinic-line);border-radius:16px;background:var(--kinic-white);color:var(--kinic-ink);box-shadow:0 24px 60px rgb(0 0 0 / 18%);font:14px/1.42 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.panel-header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--kinic-line);padding:14px 18px;background:var(--kinic-white)}
.brand{display:flex;align-items:center;gap:10px;min-width:0}.brand strong{display:block;font-size:15px;font-weight:700}.brand p{margin:2px 0 0;color:var(--kinic-body);font-size:12px;font-weight:550}.close{display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--kinic-line);border-radius:12px;background:var(--kinic-white);color:var(--kinic-body);font-size:17px;font-weight:800;transition:background .3s ease,border-color .3s ease,color .3s ease,transform .3s ease}
.close:hover{border-color:var(--kinic-hot-pink);background:var(--kinic-hot-pink);color:var(--kinic-white);transform:translateY(-3px)}
.close:focus-visible{outline:2px solid var(--kinic-soft-pink);outline-offset:2px}
.settings{margin:12px;border:1px solid var(--kinic-line);border-radius:16px;background:var(--kinic-paper);padding:16px}
input,select{border:1px solid var(--kinic-mid-line);border-radius:12px;background:var(--kinic-white);color:var(--kinic-ink);padding:9px 12px;font:inherit}
input:focus,select:focus{border-color:var(--kinic-hot-pink);outline:2px solid var(--kinic-soft-pink);outline-offset:1px}
.export-block{display:grid;gap:10px}.export-block strong{font-size:15px}.database-field{display:grid;gap:6px;color:var(--kinic-ink);font-weight:800}.database-field span{font-size:12px}.database-field select{width:100%;font-weight:650}.export-warning{margin:0;color:#d5691b;font-weight:750}.setup-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--kinic-pale-pink);border-radius:16px;padding:12px 14px;background:var(--kinic-soft-pink)}.setup-row p{margin:0;color:var(--kinic-hot-pink);font-weight:800}.export-box{display:flex;align-items:center;justify-content:space-between;gap:18px;border:1px solid var(--kinic-line);border-radius:16px;padding:16px;background:var(--kinic-white)}.export-box p{max-width:430px;margin:0;color:var(--kinic-body);font-weight:600}.export-control{display:flex;align-items:center;gap:8px;border:1px solid var(--kinic-mid-line);border-radius:16px;padding:5px;background:var(--kinic-white)}.export-control input{width:58px;border:0;background:transparent;text-align:center;font-weight:800}.export-control button,.setup-row button,.logs button{border:1px solid var(--kinic-ink);border-radius:16px;padding:9px 14px;background:var(--kinic-ink);color:var(--kinic-white);font-weight:800;box-shadow:none;transition:background .3s ease,border-color .3s ease,color .3s ease,transform .3s ease}
.export-control button:hover,.setup-row button:hover,.logs button:hover{border-color:var(--kinic-hot-pink);background:var(--kinic-hot-pink);transform:translateY(-3px)}
.export-control button:focus-visible,.setup-row button:focus-visible,.logs button:focus-visible{outline:2px solid var(--kinic-soft-pink);outline-offset:2px}
button:disabled{opacity:.55;cursor:not-allowed}.logs{margin:12px;border:1px solid var(--kinic-line);border-radius:16px;background:var(--kinic-white);padding:14px 18px}.logs h2{margin:0 0 12px;font-size:16px}.filter{border:1px solid var(--kinic-pale-pink);border-radius:999px;background:var(--kinic-soft-pink);color:var(--kinic-hot-pink);padding:8px;text-align:center;font-weight:800}.status{min-height:20px;margin:10px 0;color:var(--kinic-body)}.status.error{color:var(--kinic-error)}.cancel{margin:0 0 10px;border:1px solid var(--kinic-line);border-radius:16px;padding:8px 12px;background:var(--kinic-white);color:var(--kinic-ink);font-weight:800;box-shadow:0 4px 10px #14142b0a}.log-list{display:grid;gap:12px;max-height:240px;overflow:auto}.log{display:grid;grid-template-columns:42px 1fr;gap:12px;border:1px solid var(--kinic-line);border-radius:16px;padding:14px;background:var(--kinic-paper)}.log-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--kinic-success-soft);color:var(--kinic-success);font-weight:900}.log.error .log-icon{background:var(--kinic-error-soft);color:var(--kinic-error)}.log-meta{display:flex;justify-content:space-between;color:var(--kinic-body);font-size:12px}.log p{margin:6px 0 0;color:var(--kinic-ink);font-weight:650}
`;
