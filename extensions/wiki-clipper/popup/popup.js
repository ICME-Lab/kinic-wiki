import { normalizeKnowledgeTargetRoot } from "@kinic/source-contracts";
// Where: extensions/wiki-clipper/popup/popup.js
// What: Popup settings and Internet Identity session controls.
// Why: Toolbar click runs without UI, but setup/login need a visible extension page.
import { authSnapshot, loginWithInternetIdentity, logoutInternetIdentity } from "../src/auth-client.js";
import { DEFAULT_CANISTER_ID, DEFAULT_IC_HOST } from "../src/source-capture-request.js";
import { createDatabase, listWritableDatabases } from "../src/vfs-actor.js";
import {
  DEFAULT_DATABASE_NAME,
  databaseOptionLabel,
  mergePreferredDatabase,
  shouldShowCreateDatabaseForm,
  validateCreateDatabaseName
} from "./popup-state.js";

const principalText = document.querySelector("#principal");
const loginButton = document.querySelector("#login");
const logoutButton = document.querySelector("#logout");
const databaseSelect = document.querySelector("#database-id");
const showSaveControlsInput = document.querySelector("#show-save-controls");
showSaveControlsInput.disabled = true;
const createDatabaseForm = document.querySelector("#create-database-form");
const databaseNameInput = document.querySelector("#database-name");
const createDatabaseButton = document.querySelector("#create-database");
const statusText = document.querySelector("#status");
const latestStatusText = document.querySelector("#latest-status");
const DEFAULT_DATABASE_ID = process.env.KINIC_CAPTURE_DATABASE_ID || "";

loginButton.addEventListener("click", async () => {
  try {
    statusText.textContent = "Opening Internet Identity...";
    await loginWithInternetIdentity();
    await notifyAuthSessionChanged();
    await refreshAuthAndDatabases();
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await logoutInternetIdentity();
    await saveDatabaseSelection("");
    await notifyAuthSessionChanged();
    await refreshAuthAndDatabases();
    statusText.textContent = "Logged out";
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
  }
});

databaseSelect.addEventListener("change", async () => {
  if (!databaseSelect.value) return;
  try {
    await saveDatabaseSelection(databaseSelect.value);
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
  }
});

showSaveControlsInput.addEventListener("change", async () => {
  try {
    await saveShowSaveControlsSetting(showSaveControlsInput.checked);
    statusText.textContent = showSaveControlsInput.checked ? "Save controls shown" : "Save controls hidden";
  } catch (error) {
    showSaveControlsInput.checked = !showSaveControlsInput.checked;
    statusText.textContent = error instanceof Error ? error.message : String(error);
  }
});

createDatabaseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  createDatabaseButton.disabled = true;
  try {
    const name = validateCreateDatabaseName(databaseNameInput.value);
    const snapshot = await authSnapshot();
    if (!snapshot.isAuthenticated || !snapshot.identity) {
      throw new Error("Login to create a database.");
    }
    statusText.textContent = "Creating database...";
    const created = await createDatabase(
      {
        canisterId: DEFAULT_CANISTER_ID,
        host: DEFAULT_IC_HOST,
        identity: snapshot.identity
      },
      name
    );
    await refreshAuthAndDatabases(created);
    statusText.textContent = "Database created. Purchase cycles before capture.";
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    createDatabaseButton.disabled = false;
  }
});

const webTargetRootInput = document.querySelector("#web-target-root");
const conversationTargetRootInput = document.querySelector("#conversation-target-root");
let savedFolders = { webTargetRoot: "/Knowledge/web", conversationTargetRoot: "/Knowledge/conversations" };
let folderLoadSequence = 0;
let generationSaving = false;
let availableFolders = [];
const pendingFolders = {};
for (const [key, select] of [["webTargetRoot", webTargetRootInput], ["conversationTargetRoot", conversationTargetRootInput]]) {
  select.addEventListener("change", async () => {
    const previous = savedFolders[key];
    generationSaving = true;
    webTargetRootInput.disabled = conversationTargetRootInput.disabled = true;
    try {
      const value = normalizeKnowledgeTargetRoot(select.value);
      pendingFolders[key] = value;
      await send({ type: "save-config", config: { [key]: value } });
      savedFolders[key] = value;
      statusText.textContent = "Generation folder saved.";
    } catch (error) {
      savedFolders[key] = previous;
      statusText.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      delete pendingFolders[key];
      generationSaving = false;
      renderGenerationFolders();
    }
  });
}

function renderGenerationFolders(paths = availableFolders) {
  availableFolders = paths;
  const options = new Set(["/Knowledge/web", "/Knowledge/conversations", ...Object.values(savedFolders), ...Object.values(pendingFolders)]);
  for (const path of paths) {
    try { options.add(normalizeKnowledgeTargetRoot(path)); } catch { /* Ignore non-folder paths. */ }
  }
  for (const [key, select] of [["webTargetRoot", webTargetRootInput], ["conversationTargetRoot", conversationTargetRootInput]]) {
    select.textContent = "";
    for (const path of [...options].sort((a, b) => a.localeCompare(b))) {
      const option = document.createElement("option");
      option.value = option.textContent = path;
      select.append(option);
    }
    select.value = pendingFolders[key] ?? savedFolders[key];
    select.disabled = generationSaving;
  }
}

async function refreshGenerationFolders(databaseId) {
  const sequence = ++folderLoadSequence;
  renderGenerationFolders([]);
  if (!databaseId) return;
  try {
    const response = await send({ type: "list-generation-folders" });
    if (sequence !== folderLoadSequence) return;
    renderGenerationFolders(response.result?.folders || []);
    if (response.result?.truncated) {
      statusText.textContent = `Showing the first ${response.result.folders.length} folders. Other folders are not listed.`;
    }
  } catch (error) {
    if (sequence === folderLoadSequence) statusText.textContent = error instanceof Error ? error.message : String(error);
  }
}

load();

async function load() {
  try {
    await loadUiSettings();
    await refreshLatestStatus();
    await refreshAuthAndDatabases();
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function loadUiSettings() {
  const response = await send({ type: "load-config" });
  savedFolders = {
    webTargetRoot: response.config?.webTargetRoot ?? "/Knowledge/web",
    conversationTargetRoot: response.config?.conversationTargetRoot ?? "/Knowledge/conversations"
  };
  showSaveControlsInput.checked = response.config?.showSaveControls !== false
    && response.config?.showSaveControls !== "false";
  showSaveControlsInput.disabled = false;
  void refreshGenerationFolders(response.config?.databaseId || "");
}

async function saveShowSaveControlsSetting(showSaveControls) {
  await send({ type: "save-config", config: { showSaveControls: Boolean(showSaveControls) } });
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "extension request failed");
  }
  return response;
}

async function notifyAuthSessionChanged() {
  await send({ type: "auth-session-changed" });
}

async function saveDatabaseSelection(databaseId) {
  await send({ type: "save-config", config: { databaseId } });
  statusText.textContent = databaseId ? "Database selected" : "No writable active databases found.";
  await refreshGenerationFolders(databaseId);
}

async function refreshAuthAndDatabases(preferredDatabase = null) {
  const snapshot = await authSnapshot();
  principalText.textContent = snapshot.isAuthenticated ? snapshot.principal : "Not logged in";
  loginButton.disabled = snapshot.isAuthenticated;
  logoutButton.disabled = !snapshot.isAuthenticated;
  if (!snapshot.isAuthenticated) {
    setCreateDatabaseFormVisible(false);
    renderDatabaseOptions([], "", "Login to load writable databases.");
    return;
  }
  const response = await send({ type: "load-config" });
  const databases = mergePreferredDatabase(await listWritableDatabases({
    canisterId: DEFAULT_CANISTER_ID,
    host: DEFAULT_IC_HOST,
    identity: snapshot.identity
  }), preferredDatabase);
  const storedDatabaseId = response.config?.databaseId || "";
  const preferredDatabaseId = preferredDatabase?.databaseId || "";
  const selectedDatabaseId = renderDatabaseOptions(databases, preferredDatabaseId || storedDatabaseId || DEFAULT_DATABASE_ID);
  setCreateDatabaseFormVisible(
    shouldShowCreateDatabaseForm({
      isAuthenticated: snapshot.isAuthenticated,
      writableDatabaseCount: databases.length
    })
  );
  if (!selectedDatabaseId) {
    await saveDatabaseSelection("");
    return;
  }
  if (selectedDatabaseId !== storedDatabaseId) {
    await saveDatabaseSelection(selectedDatabaseId);
    return;
  }
  statusText.textContent = "Database selected";
  await refreshGenerationFolders(selectedDatabaseId);
}

function renderDatabaseOptions(databases, selectedDatabaseId, placeholder = "No writable active databases found.") {
  databaseSelect.textContent = "";
  if (databases.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    databaseSelect.append(option);
    databaseSelect.disabled = true;
    return "";
  }
  const nameCounts = databaseNameCounts(databases);
  for (const database of databases) {
    const option = document.createElement("option");
    option.value = database.databaseId;
    const label = databaseOptionLabel(database, nameCounts.get(databaseNameKey(database.name)) || 1);
    option.disabled = !database.writeCyclesAvailable;
    option.textContent = database.writeCyclesAvailable ? label : `${label} - ${database.cyclesReason}`;
    option.title = database.databaseId;
    databaseSelect.append(option);
  }
  const selectable = databases.filter((database) => database.writeCyclesAvailable);
  if (selectable.length === 0) {
    databaseSelect.value = "";
    databaseSelect.disabled = true;
    return "";
  }
  databaseSelect.value = selectable.some((database) => database.databaseId === selectedDatabaseId)
    ? selectedDatabaseId
    : selectable[0].databaseId;
  databaseSelect.disabled = false;
  return databaseSelect.value;
}

function databaseNameCounts(databases) {
  const counts = new Map();
  for (const database of databases) {
    const key = databaseNameKey(database.name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function databaseNameKey(name) {
  return String(name || "").trim().toLowerCase();
}

function setCreateDatabaseFormVisible(visible) {
  createDatabaseForm.hidden = !visible;
  if (visible && !databaseNameInput.value.trim()) {
    databaseNameInput.value = DEFAULT_DATABASE_NAME;
  }
}

async function refreshLatestStatus() {
  const response = await send({ type: "latest-source-capture-status" });
  const value = response.value ? JSON.parse(response.value) : null;
  latestStatusText.textContent = value ? latestStatusLabel(value) : "No run yet.";
}

function latestStatusLabel(value) {
  const prefix =
    value.status === "setup_required"
      ? "setup required"
      : value.status === "source_exists"
        ? "already saved"
        : value.status;
  if (value.status === "error") {
    return `${prefix}: ${value.message}${value.url ? ` ${value.url}` : ""}`;
  }
  return `${prefix}: ${value.message}${value.sourcePath ? ` ${value.sourcePath}` : ""}`;
}
