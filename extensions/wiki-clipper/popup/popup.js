// Where: extensions/wiki-clipper/popup/popup.js
// What: Popup settings and Internet Identity session controls.
// Why: Toolbar click runs without UI, but setup/login need a visible extension page.
import { authSnapshot, loginWithInternetIdentity, logoutInternetIdentity } from "../src/auth-client.js";
import { DEFAULT_CANISTER_ID, DEFAULT_IC_HOST } from "../src/url-ingest-request.js";
import { listWritableDatabases } from "../src/vfs-actor.js";

const principalText = document.querySelector("#principal");
const loginButton = document.querySelector("#login");
const logoutButton = document.querySelector("#logout");
const databaseSelect = document.querySelector("#database-id");
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
  statusText.textContent = databaseId ? "Database selected" : "No writable hot databases found.";
}

async function refreshAuthAndDatabases() {
  const snapshot = await authSnapshot();
  principalText.textContent = snapshot.isAuthenticated ? snapshot.principal : "Not logged in";
  loginButton.disabled = snapshot.isAuthenticated;
  logoutButton.disabled = !snapshot.isAuthenticated;
  if (!snapshot.isAuthenticated) {
    renderDatabaseOptions([], "", "Login to load writable databases.");
    return;
  }
  const response = await send({ type: "load-config" });
  const databases = await listWritableDatabases({
    canisterId: DEFAULT_CANISTER_ID,
    host: DEFAULT_IC_HOST,
    identity: snapshot.identity
  });
  const storedDatabaseId = response.config?.databaseId || "";
  const selectedDatabaseId = renderDatabaseOptions(databases, storedDatabaseId || DEFAULT_DATABASE_ID);
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

function renderDatabaseOptions(databases, selectedDatabaseId, placeholder = "No writable hot databases found.") {
  databaseSelect.textContent = "";
  if (databases.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    databaseSelect.append(option);
    databaseSelect.disabled = true;
    return "";
  }
  for (const database of databases) {
    const option = document.createElement("option");
    option.value = database.databaseId;
    option.disabled = !database.billable;
    option.textContent = database.billable
      ? `${database.name || database.databaseId} (${database.role})`
      : `${database.name || database.databaseId} (${database.role}) - ${database.billingReason}`;
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

async function refreshLatestStatus() {
  const response = await send({ type: "latest-url-ingest-status" });
  const value = response.value ? JSON.parse(response.value) : null;
  latestStatusText.textContent = value ? latestStatusLabel(value) : "No run yet.";
}

function latestStatusLabel(value) {
  const prefix = value.status === "setup_required" ? "setup required" : value.status;
  return `${prefix}: ${value.message}${value.requestPath ? ` ${value.requestPath}` : ""}`;
}
