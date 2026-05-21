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
const refreshDatabasesButton = document.querySelector("#refresh-databases");
const saveButton = document.querySelector("#save-settings");
const statusText = document.querySelector("#status");
const latestStatusText = document.querySelector("#latest-status");
const DEFAULT_DATABASE_ID = process.env.KINIC_CAPTURE_DATABASE_ID || "";

loginButton.addEventListener("click", async () => {
  try {
    statusText.textContent = "Opening Internet Identity...";
    await loginWithInternetIdentity();
    await refreshAuthAndDatabases();
    statusText.textContent = "Logged in";
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

refreshDatabasesButton.addEventListener("click", async () => {
  try {
    await refreshAuthAndDatabases();
  } catch (error) {
    statusText.textContent = error instanceof Error ? error.message : String(error);
  }
});

saveButton.addEventListener("click", async () => {
  try {
    await send({ type: "save-config", config: currentConfig() });
    statusText.textContent = "Settings saved";
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

function currentConfig() {
  return {
    databaseId: databaseSelect.value || ""
  };
}

async function refreshAuthAndDatabases() {
  const snapshot = await authSnapshot();
  principalText.textContent = snapshot.isAuthenticated ? snapshot.principal : "Not logged in";
  loginButton.disabled = snapshot.isAuthenticated;
  logoutButton.disabled = !snapshot.isAuthenticated;
  refreshDatabasesButton.disabled = !snapshot.isAuthenticated;
  saveButton.disabled = !snapshot.isAuthenticated;
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
  renderDatabaseOptions(databases, response.config.databaseId || DEFAULT_DATABASE_ID);
  statusText.textContent = databases.length === 0 ? "No writable hot databases found." : "Databases loaded";
}

function renderDatabaseOptions(databases, selectedDatabaseId, placeholder = "No writable hot databases found.") {
  databaseSelect.textContent = "";
  if (databases.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    databaseSelect.append(option);
    databaseSelect.disabled = true;
    saveButton.disabled = true;
    return;
  }
  for (const database of databases) {
    const option = document.createElement("option");
    option.value = database.databaseId;
    option.textContent = `${database.name || database.databaseId} (${database.role})`;
    databaseSelect.append(option);
  }
  databaseSelect.value = databases.some((database) => database.databaseId === selectedDatabaseId)
    ? selectedDatabaseId
    : databases[0].databaseId;
  databaseSelect.disabled = false;
  saveButton.disabled = false;
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
