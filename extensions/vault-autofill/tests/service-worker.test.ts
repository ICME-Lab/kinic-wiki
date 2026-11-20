import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleAutoLockAlarm,
  handleMessage,
  setServiceWorkerDepsForTest
} from "../src/service-worker.ts";
import type { DecryptedItemView, VaultItemSummary } from "../src/types.ts";

const EXT_ID = "dlbffglcocnllllhjaapackocgkaegak";

const GITHUB_ITEM: VaultItemSummary = {
  objectIdHex: "01".repeat(16),
  vaultIdHex: "aa".repeat(16),
  revision: "1",
  kind: "credential",
  title: "GitHub",
  username: "alice@example.com",
  domains: ["github.com"],
  hasTotp: true,
  favorite: true,
  tags: ["dev"],
  updatedAtMs: 1
};

const GITHUB_DECRYPTED: DecryptedItemView = {
  summary: GITHUB_ITEM,
  label: "GitHub",
  username: "alice@example.com",
  password: "old-password",
  url: "https://github.com/login",
  urls: ["https://github.com/login"],
  totpSecret: "JBSWY3DPEHPK3PXP",
  totp: {
    code: "123456",
    formattedCode: "123 456",
    remainingSeconds: 20,
    period: 30
  },
  notes: "keep my notes",
  customFields: [{ label: "Recovery", value: "xyz" }],
  favorite: true,
  tags: ["dev"],
  rawText: "{}"
};

describe("Service worker security boundaries and save-banner workflow", () => {
  let localStore: Record<string, unknown>;
  let sessionStore: Record<string, unknown>;
  let badgeCalls: Array<{ tabId: number | undefined; text: string }>;
  let offscreenCalls: Array<Record<string, unknown>>;

  beforeEach(() => {
    localStore = {};
    sessionStore = {};
    badgeCalls = [];
    offscreenCalls = [];

    setServiceWorkerDepsForTest({
      extensionId: () => EXT_ID,
      storage: {
        getLocal: async (key) => ({ [key]: localStore[key] }),
        setLocal: async (items) => {
          Object.assign(localStore, items);
        },
        getSession: async (key) => ({ [key]: sessionStore[key] }),
        setSession: async (items) => {
          Object.assign(sessionStore, items);
        }
      },
      setBadge: async (tabId, text) => {
        badgeCalls.push({ tabId, text });
      },
      sendToTab: vi.fn(async () => ({ ok: true })),
      queryActiveTab: async () => ({
        id: 7,
        url: "https://github.com/login",
        title: "Sign in to GitHub"
      }),
      scheduleAutoLock: vi.fn(async () => {}),
      clearAutoLock: vi.fn(async () => {}),
      now: () => 1_700_000_000_000,
      offscreenBridge: async (msg) => {
        offscreenCalls.push(msg);
        if (msg.type === "get-matches-for-url") {
          const url = String(msg.url ?? "");
          return {
            ok: true,
            result: {
              unlocked: true,
              domain: url.includes("github.com") ? "github.com" : "evil.example",
              matches: url.includes("github.com") ? [GITHUB_ITEM] : []
            }
          };
        }
        if (msg.type === "read-item") {
          return { ok: true, result: GITHUB_DECRYPTED };
        }
        if (msg.type === "evaluate-submitted-login") {
          return {
            ok: true,
            result: {
              action: "update",
              existingObjectIdHex: GITHUB_ITEM.objectIdHex,
              domain: "github.com",
              title: "GitHub"
            }
          };
        }
        if (msg.type === "save-credential") {
          return { ok: true, result: GITHUB_ITEM };
        }
        if (msg.type === "lock-vault") {
          return { ok: true, result: { isUnlocked: false } };
        }
        return { ok: true, result: {} };
      }
    });
  });

  it("blocks spoofed senders, subframes, and cross-domain inline credential requests", async () => {
    // Subframe rejected
    await expect(
      handleMessage(
        { type: "get-inline-matches" },
        { id: EXT_ID, frameId: 2, tab: { id: 7, url: "https://github.com/login" } }
      )
    ).rejects.toThrow("TOP_FRAME_REQUIRED");

    // Wrong extension ID rejected
    await expect(
      handleMessage(
        { type: "get-state" },
        { id: "other-extension-id" }
      )
    ).rejects.toThrow("UNAUTHORIZED_SENDER");

    // Compromised evil.example page cannot request GitHub's objectIdHex
    await expect(
      handleMessage(
        { type: "fill-inline-item", objectIdHex: GITHUB_ITEM.objectIdHex },
        { id: EXT_ID, frameId: 0, tab: { id: 9, url: "https://evil.example/login" } }
      )
    ).rejects.toThrow("CREDENTIAL_DOMAIN_MISMATCH");

    // Legitimate top-frame github.com tab receives credentials on explicit click
    const filled = await handleMessage(
      { type: "fill-inline-item", objectIdHex: GITHUB_ITEM.objectIdHex },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://github.com/login" } }
    );
    expect(filled.result).toEqual({
      username: "alice@example.com",
      password: "old-password",
      totp: "123456"
    });
  });

  it("preserves pending save prompts across same-domain redirects and retains existing TOTP/notes on update", async () => {
    const submitted = await handleMessage(
      {
        type: "login-submitted",
        username: "alice@example.com",
        password: "new-password-456",
        pageTitle: "GitHub"
      },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://github.com/session" } }
    );
    const prompt = (submitted.result as { prompt: { id: string; mode: string } }).prompt;
    expect(prompt.mode).toBe("update");

    // Survives redirect to github.com dashboard
    const checkedSame = await handleMessage(
      { type: "check-pending-save-banner" },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://github.com/dashboard" } }
    );
    expect((checkedSame.result as { prompt: { id: string } | null }).prompt?.id).toBe(
      prompt.id
    );

    // Does NOT leak prompt onto an unrelated domain
    const checkedOther = await handleMessage(
      { type: "check-pending-save-banner" },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://other.example/" } }
    );
    expect((checkedOther.result as { prompt: null }).prompt).toBeNull();

    // Confirming update preserves existing TOTP, notes, and customFields
    await handleMessage(
      {
        type: "save-banner-confirm",
        promptId: prompt.id,
        title: "GitHub",
        username: "alice@example.com"
      },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://github.com/dashboard" } }
    );
    const saveCall = offscreenCalls.find((c) => c.type === "save-credential");
    expect(saveCall?.input).toMatchObject({
      objectIdHex: GITHUB_ITEM.objectIdHex,
      password: "new-password-456",
      totp: "JBSWY3DPEHPK3PXP",
      notes: "keep my notes",
      customFields: [{ label: "Recovery", value: "xyz" }]
    });

    // Prompt is cleared after confirmation
    const afterConfirm = await handleMessage(
      { type: "check-pending-save-banner" },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://github.com/dashboard" } }
    );
    expect((afterConfirm.result as { prompt: null }).prompt).toBeNull();
  });

  it("allows auth-signed-in from extension auth tab without wiping device keys and rejects web tabs", async () => {
    await handleMessage(
      { type: "auth-signed-in" },
      {
        id: EXT_ID,
        url: `chrome-extension://${EXT_ID}/auth/login.html`,
        tab: { id: 20, url: `chrome-extension://${EXT_ID}/auth/login.html` }
      }
    );
    expect(offscreenCalls.some((c) => c.type === "reload-auth-session")).toBe(true);
    expect(offscreenCalls.some((c) => c.type === "forget-and-reset")).toBe(false);

    await expect(
      handleMessage(
        { type: "auth-signed-in" },
        { id: EXT_ID, url: "https://evil.example/", tab: { id: 21, url: "https://evil.example/" } }
      )
    ).rejects.toThrow("UNAUTHORIZED_SENDER");

    await handleMessage({ type: "auth-signed-out" }, { id: EXT_ID });
    expect(offscreenCalls.some((c) => c.type === "forget-and-reset")).toBe(true);
  });

  it("clears pending save prompts, locks Vault, and clears badge on auto-lock alarm", async () => {
    await handleMessage(
      {
        type: "login-submitted",
        username: "alice@example.com",
        password: "secret-password"
      },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://github.com/login" } }
    );
    await handleAutoLockAlarm();

    expect(offscreenCalls.some((c) => c.type === "lock-vault")).toBe(true);
    expect(badgeCalls.at(-1)).toEqual({ tabId: 7, text: "" });
    const afterLock = await handleMessage(
      { type: "check-pending-save-banner" },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://github.com/login" } }
    );
    expect((afterLock.result as { prompt: null }).prompt).toBeNull();
  });
});
