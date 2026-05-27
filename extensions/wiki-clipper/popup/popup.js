// Where: extensions/wiki-clipper/popup/popup.js
// What: Popup settings and Internet Identity session controls.
// Why: Toolbar click runs without UI, but setup/login need a visible extension page.
import { authSnapshot, loginWithInternetIdentity, logoutInternetIdentity } from "../src/auth-client.js";
import { DEFAULT_CANISTER_ID, DEFAULT_IC_HOST } from "../src/url-ingest-request.js";
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
    await refreshAuthAndDatabases();
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await logoutInternetIdentity();
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
    await saveDatabaseSelection(created.databaseId);
    await refreshAuthAndDatabases(created);
    statusText.textContent = "Database created";
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
  const nameCounts = databaseNameCounts(databases);
  for (const database of databases) {
    const option = document.createElement("option");
    option.value = database.databaseId;
    const label = databaseOptionLabel(database, nameCounts.get(databaseNameKey(database.name)) || 1);
    option.disabled = !database.billable;
    option.textContent = database.billable ? label : `${label} - ${database.billingReason}`;
    option.title = database.databaseId;
    databaseSelect.append(option);
  }
  const selectable = databases.filter((database) => database.billable);
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
  const response = await send({ type: "latest-url-ingest-status" });
  const value = response.value ? JSON.parse(response.value) : null;
  latestStatusText.textContent = value ? latestStatusLabel(value) : "No run yet.";
}

function latestStatusLabel(value) {
  const prefix = value.status === "setup_required" ? "setup required" : value.status;
  return `${prefix}: ${value.message}${value.requestPath ? ` ${value.requestPath}` : ""}`;
}
