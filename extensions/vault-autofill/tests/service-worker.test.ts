import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingSaveIfNavigatedAway,
  handleAutoLockAlarm,
  handleMessage,
  refreshTabBadge,
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
  let offscreenRunning: boolean;
  let scheduleAutoLockSpy: ReturnType<typeof vi.fn<(minutes: number) => Promise<void>>>;
  let sendToTabSpy: ReturnType<
    typeof vi.fn<(tabId: number, message: Record<string, unknown>) => Promise<unknown>>
  >;
  let activeTabUrl: string;

  beforeEach(() => {
    localStore = {};
    sessionStore = {};
    badgeCalls = [];
    offscreenCalls = [];
    offscreenRunning = true;
    activeTabUrl = "https://github.com/login";
    scheduleAutoLockSpy = vi.fn(async () => {});
    sendToTabSpy = vi.fn(async (_tabId, message) => {
      if (message.type === "fill-credentials") {
        return {
          ok: true,
          result: { filledUsername: true, filledPassword: true, filledTotp: false }
        };
      }
      if (message.type === "fill-generated-password") {
        return { ok: true, result: { filledCount: 1 } };
      }
      return { ok: true };
    });

    setServiceWorkerDepsForTest({
      extensionId: () => EXT_ID,
      hasExistingOffscreen: async () => offscreenRunning,
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
      sendToTab: sendToTabSpy,
      queryActiveTab: async () => ({
        id: 7,
        url: activeTabUrl,
        title: "Sign in to GitHub"
      }),
      scheduleAutoLock: scheduleAutoLockSpy,
      clearAutoLock: vi.fn(async () => {}),
      now: () => 1_700_000_000_000,
      offscreenBridge: async (msg) => {
        offscreenCalls.push(msg);
        if (msg.type === "get-state") {
          return { ok: true, result: { isUnlocked: true } };
        }
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

    // Does NOT leak prompt onto an unrelated domain (and clears it on cross-domain check)
    const checkedOther = await handleMessage(
      { type: "check-pending-save-banner" },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://other.example/" } }
    );
    expect((checkedOther.result as { prompt: null }).prompt).toBeNull();

    // Re-submit on github.com and verify confirm rejects cross-domain, then succeeds on github.com
    const submitted2 = await handleMessage(
      {
        type: "login-submitted",
        username: "alice@example.com",
        password: "new-password-456",
        pageTitle: "GitHub"
      },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://github.com/session" } }
    );
    const prompt2 = (submitted2.result as { prompt: { id: string } }).prompt;

    await expect(
      handleMessage(
        {
          type: "save-banner-confirm",
          promptId: prompt2.id,
          title: "GitHub",
          username: "alice@example.com"
        },
        { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://evil.example/" } }
      )
    ).rejects.toThrow("SAVE_PROMPT_DOMAIN_MISMATCH");

    // Re-submit and confirm on github.com to verify preservation of existing TOTP/notes/customFields
    const submitted3 = await handleMessage(
      {
        type: "login-submitted",
        username: "alice@example.com",
        password: "new-password-456",
        pageTitle: "GitHub"
      },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://github.com/session" } }
    );
    const prompt3 = (submitted3.result as { prompt: { id: string } }).prompt;

    await handleMessage(
      {
        type: "save-banner-confirm",
        promptId: prompt3.id,
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

  it("does not wake the offscreen document for passive tab/focus checks when none is running", async () => {
    offscreenRunning = false;
    await refreshTabBadge({ id: 7, url: "https://github.com/login" });
    const inline = await handleMessage(
      { type: "get-inline-matches" },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://github.com/login" } }
    );
    expect(inline.result).toMatchObject({ enabled: true, unlocked: false, matches: [] });
    expect(offscreenCalls).toHaveLength(0);
    expect(badgeCalls.at(-1)).toEqual({ tabId: 7, text: "" });
  });

  it("clears pending save prompt on cross-domain navigation, guards cross-domain popup fill, and reschedules auto-lock", async () => {
    await handleMessage(
      {
        type: "login-submitted",
        username: "alice@example.com",
        password: "secret-password"
      },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://github.com/login" } }
    );
    await clearPendingSaveIfNavigatedAway(7, "https://unrelated.example/");
    const afterNav = await handleMessage(
      { type: "check-pending-save-banner" },
      { id: EXT_ID, frameId: 0, tab: { id: 7, url: "https://github.com/login" } }
    );
    expect((afterNav.result as { prompt: null }).prompt).toBeNull();

    // Cross-domain popup fill requires explicit allowCrossDomain confirmation
    activeTabUrl = "https://other.example/login";
    await expect(
      handleMessage(
        { type: "fill-active-tab", objectIdHex: GITHUB_ITEM.objectIdHex },
        { id: EXT_ID }
      )
    ).rejects.toThrow("CROSS_DOMAIN_CONFIRM_REQUIRED");

    // Reporting error when no login form exists on the page
    activeTabUrl = "https://github.com/login";
    sendToTabSpy.mockResolvedValueOnce({
      ok: true,
      result: { filledUsername: false, filledPassword: false, filledTotp: false }
    });
    await expect(
      handleMessage(
        { type: "fill-active-tab", objectIdHex: GITHUB_ITEM.objectIdHex },
        { id: EXT_ID }
      )
    ).rejects.toThrow("No login form found on this page.");
    expect(sendToTabSpy).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({
        type: "fill-credentials",
        expectedOrigin: "https://github.com"
      })
    );

    // Rejects fill if the page navigated to a different origin before delivery
    sendToTabSpy.mockResolvedValueOnce({
      ok: false,
      error: "ORIGIN_MISMATCH"
    });
    await expect(
      handleMessage(
        { type: "fill-active-tab", objectIdHex: GITHUB_ITEM.objectIdHex },
        { id: EXT_ID }
      )
    ).rejects.toThrow("Page origin changed before autofill completed. Try again.");

    // save-settings reschedules active auto-lock alarm and clamps > 30 min to default 30
    const saved = await handleMessage(
      { type: "save-settings", settings: { autoLockMinutes: 15 } },
      { id: EXT_ID }
    );
    expect(saved.result).toMatchObject({ autoLockMinutes: 15 });
    expect(scheduleAutoLockSpy).toHaveBeenCalledWith(15);
  });
});
