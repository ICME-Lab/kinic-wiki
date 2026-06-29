// Where: extensions/wiki-clipper/popup/popup.js
// What: Popup settings and Internet Identity session controls.
// Why: Toolbar click runs without UI, but setup/login need a visible extension page.
import { authSnapshot, loginWithInternetIdentity, logoutInternetIdentity } from "../src/auth-client.js";
import { DEFAULT_CANISTER_ID, DEFAULT_IC_HOST } from "../src/source-capture-request.js";
import { createDatabase, listWritableDatabases } from "../src/vfs-actor.js";
import {
  DEFAULT_DATABASE_TITLE,
  databaseOptionLabel,
  mergePreferredDatabase,
  shouldShowCreateDatabaseForm,
  validateCreateDatabaseTitle
} from "./popup-state.js";

const principalText = document.querySelector("#principal");
const loginButton = document.querySelector("#login");
const logoutButton = document.querySelector("#logout");
const databaseSelect = document.querySelector("#database-id");
const createDatabaseForm = document.querySelector("#create-database-form");
const databaseTitleInput = document.querySelector("#database-title");
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

createDatabaseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  createDatabaseButton.disabled = true;
  try {
    const title = validateCreateDatabaseTitle(databaseTitleInput.value);
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
      title
    );
    await refreshAuthAndDatabases(created);
    statusText.textContent = "Database created. Purchase cycles before capture.";
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    createDatabaseButton.disabled = false;
  }
});

load();

async function load() {
  try {
    await refreshLatestStatus();
    await refreshAuthAndDatabases();
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
  }
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
  const titleCounts = databaseTitleCounts(databases);
  for (const database of databases) {
    const option = document.createElement("option");
    option.value = database.databaseId;
    const label = databaseOptionLabel(database, titleCounts.get(databaseTitleKey(database.title)) || 1);
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

function databaseTitleCounts(databases) {
  const counts = new Map();
  for (const database of databases) {
    const key = databaseTitleKey(database.title);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function databaseTitleKey(title) {
  return String(title || "").trim().toLowerCase();
}

function setCreateDatabaseFormVisible(visible) {
  createDatabaseForm.hidden = !visible;
  if (visible && !databaseTitleInput.value.trim()) {
    databaseTitleInput.value = DEFAULT_DATABASE_TITLE;
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
  return `${prefix}: ${value.message}${value.sourcePath ? ` ${value.sourcePath}` : ""}`;
}
