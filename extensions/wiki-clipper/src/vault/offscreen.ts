// Where: extensions/vault-autofill/src/offscreen.ts
// What: MV3 offscreen document entrypoint hosting the in-memory VaultEngine.
// Why: Internet Identity AuthClient and IndexedDB BrowserDeviceKeys require a DOM context, not a service worker.
import { VaultEngine } from "./vault-engine.ts";
import type { ItemCategoryFilter, SaveCredentialInput } from "./types.ts";

let engine = new VaultEngine();

export function setOffscreenEngineForTest(nextEngine: VaultEngine): void {
  engine = nextEngine;
}

export async function handleOffscreenMessage(message: Record<string, unknown>): Promise<unknown> {
  switch (message.type) {
    case "auth-status":
      return engine.authStatus();
    case "get-state":
      return engine.getState();
    case "list-vaults":
      return engine.listVaults();
    case "create-vault":
      return engine.createVault();
    case "unlock-vault":
      return engine.unlockVault(
        typeof message.vaultIdHex === "string" ? message.vaultIdHex : undefined
      );
    case "refresh-items":
      return engine.refreshItems();
    case "lock-vault":
      return engine.lockVault();
    case "reload-auth-session":
      return engine.reloadAuthSession();
    case "forget-and-reset":
      return engine.forgetAndReset();
    case "list-items":
      return engine.listItems({
        url: typeof message.url === "string" ? message.url : undefined,
        query: typeof message.query === "string" ? message.query : undefined,
        filter: (message.filter as ItemCategoryFilter | undefined) ?? "all"
      });
    case "get-matches-for-url":
      return engine.getMatchesForUrl(typeof message.url === "string" ? message.url : "");
    case "read-item":
      if (typeof message.objectIdHex !== "string" || !message.objectIdHex) {
        throw new Error("Item identifier is required.");
      }
      return engine.readItem(message.objectIdHex);
    case "save-credential":
      return engine.saveCredential(message.input as SaveCredentialInput);
    case "delete-item":
      if (typeof message.objectIdHex !== "string" || !message.objectIdHex) {
        throw new Error("Item identifier is required.");
      }
      return engine.deleteItem(message.objectIdHex);
    case "evaluate-submitted-login":
      return engine.evaluateSubmittedLogin({
        url: typeof message.url === "string" ? message.url : "",
        username: typeof message.username === "string" ? message.username : "",
        password: typeof message.password === "string" ? message.password : "",
        pageTitle: typeof message.pageTitle === "string" ? message.pageTitle : undefined
      });
    default:
      throw new Error(`Unsupported offscreen action: ${String(message.type)}`);
  }
}

declare const chrome: {
  runtime?: {
    onMessage?: {
      addListener: (
        cb: (
          message: Record<string, unknown>,
          sender: unknown,
          sendResponse: (response: unknown) => void
        ) => boolean
      ) => void;
    };
  };
};

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "vault-offscreen") return false;
    handleOffscreenMessage(message).then(
      (result) => sendResponse({ ok: true, result }),
      (error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
    );
    return true;
  });
}
