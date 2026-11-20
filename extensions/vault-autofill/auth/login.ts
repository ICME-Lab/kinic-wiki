// Where: extensions/vault-autofill/auth/login.ts
// What: Persistent extension tab for completing Internet Identity login without toolbar popup dismissal.
// Why: Chrome closes toolbar popups when the II window takes focus; a full extension tab keeps window.opener alive.
import {
  authSnapshot,
  loginWithInternetIdentity
} from "../src/auth-client.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const heading = document.getElementById("heading")!;
const copy = document.getElementById("copy")!;
const btn = document.getElementById("btn-login") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;

async function sendSw(message: Record<string, unknown>) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Request failed.");
  }
  return response.result;
}

function showSignedInSuccess(): void {
  heading.textContent = "You're signed in";
  copy.textContent =
    "Kinic Vault is connected. Click the Kinic Vault icon in your Chrome toolbar to unlock and autofill logins.";
  btn.textContent = "Close this tab";
  btn.disabled = false;
  btn.onclick = () => window.close();
  statusEl.textContent = "Signed in successfully.";
  statusEl.className = "status ok";
}

async function checkInitialState(): Promise<void> {
  try {
    const snap = await authSnapshot();
    if (snap.isAuthenticated && snap.principal) {
      await sendSw({ type: "auth-signed-in" });
      showSignedInSuccess();
    }
  } catch {
    // Wait for explicit user sign-in click.
  }
}

btn.addEventListener("click", () => {
  btn.disabled = true;
  statusEl.textContent = "Waiting for Internet Identity…";
  statusEl.className = "status";
  void (async () => {
    try {
      await loginWithInternetIdentity();
      await sendSw({ type: "auth-signed-in" });
      showSignedInSuccess();
    } catch (error) {
      btn.disabled = false;
      statusEl.textContent =
        error instanceof Error ? error.message : "Sign-in did not complete. Try again.";
      statusEl.className = "status err";
    }
  })();
});

void checkInitialState();
