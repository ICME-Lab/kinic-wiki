import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { handleMessage, setServiceWorkerDepsForTest } from "../src/vault/service-worker.ts";

test("Vault popup starts and keeps account selection, generator, and editor connected", async () => {
  const html = await readFile(new URL("../popup/action-popup.html", import.meta.url), "utf8");
  const { outputFiles } = await build({
    entryPoints: [new URL("../popup/action-popup.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    write: false,
  });
  const content = await build({
    entryPoints: [new URL("../src/vault/content-autofill.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    write: false,
  });
  const css = await readFile(new URL("../popup/action-popup.css", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: chromium.executablePath() });
  try {
    const form = await browser.newPage();
    const loginUrl = "https://example.com/login";
    await form.route("https://example.com/**", (route) => {
      if (route.request().url().endsWith("/content.js")) {
        return route.fulfill({ contentType: "text/javascript", body: content.outputFiles[0].text });
      }
      return route.fulfill({ contentType: "text/html", body: `
        <form>
          <label>Username <input name="username" autocomplete="username"></label>
          <label>Password <input name="password" type="password" autocomplete="current-password"></label>
        </form>
      ` });
    });
    await form.goto(loginUrl);

    const accounts = [
      { username: "primary", password: "primary-test-password" },
      { username: "secondary", password: "secondary-test-password" },
    ];
    setServiceWorkerDepsForTest({
      extensionId: () => "kinic-test",
      queryActiveTab: async () => ({ id: 1, url: loginUrl }),
      offscreenBridge: async ({ type, target, url }) => {
        assert.equal(type, "read-login-for-url");
        assert.equal(url, loginUrl);
        const account = accounts[target.loginIndex];
        assert.ok(account);
        return { ok: true, result: { ...account, totp: null } };
      },
      storage: { getLocal: async () => ({}) },
      scheduleAutoLock: async () => {},
      sendToTab: (_tabId, message) => form.evaluate(async (payload) => {
        const { handleContentFillMessage } = await import("/content.js");
        return handleContentFillMessage(payload);
      }, message),
    });

    const page = await browser.newPage();
    await page.exposeFunction("fillTestLogin", (message) => handleMessage(message, { id: "kinic-test" }));
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Keep the real HTML and popup code, replacing the Chrome messaging boundary.
    await page.route("http://127.0.0.1:8123/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/dist/action-popup.js") {
        return route.fulfill({ contentType: "text/javascript", body: outputFiles[0].text });
      }
      if (path === "/popup/action-popup.css") {
        return route.fulfill({ contentType: "text/css", body: css });
      }
      if (path === "/popup/action-popup.html") {
        return route.fulfill({ contentType: "text/html", body: html });
      }
      return route.fulfill({ status: 404 });
    });
    await page.addInitScript(() => {
      const item = {
        objectIdHex: "abcd", vaultIdHex: "cafe", title: "Test login", username: "primary",
        revision: "2", kind: "credential", domains: ["example.com"], hasTotp: false,
        favorite: false, tags: [], updatedAtMs: 0,
      };
      const vault = { idHex: "cafe", name: "Test Vault", isOwned: true, role: "Owner", canWrite: true };
      window.testMessages = [];
      window.close = () => {};
      window.chrome = {
        permissions: { contains: async () => true },
        tabs: { query: async () => [{ url: "https://example.com/login", title: "Test site" }] },
        runtime: { sendMessage: async (message) => {
          window.testMessages.push(message);
          switch (message.type) {
            case "get-state":
              return { ok: true, result: {
                isAuthenticated: true, principal: "test", isUnlocked: true, activeVaultIdHex: "cafe",
                activeVaultName: "Test Vault", activeVaultCanWrite: true, vaults: [vault],
                itemCount: 1, unlockedAtMs: 0,
              } };
            case "load-settings":
              return { ok: true, result: { selectedVaultIdHex: "cafe", autoLockMinutes: 30, inlineTriggerEnabled: true, saveBannerEnabled: true } };
            case "list-items":
              return { ok: true, result: {
                domain: "example.com", items: [item],
                matches: [{ ...item, loginIndex: 0 }, { ...item, username: "secondary", loginIndex: 1 }],
              } };
            case "fill-active-tab":
              return window.fillTestLogin(message);
            case "save-credential":
              return { ok: true, result: item };
            case "read-item":
              return { ok: true, result: {
                summary: item, label: item.title, username: item.username, password: "test-only",
                url: "https://example.com/login", urls: ["https://example.com/login"], totpSecret: "",
                totp: null, notes: "", customFields: [], favorite: false, tags: [], rawText: "",
              } };
            default:
              return { ok: false, error: message.type };
          }
        } },
      };
    });
    await page.goto("http://127.0.0.1:8123/popup/action-popup.html");
    await page.getByRole("tab", { name: "Vault" }).click();
    assert.deepEqual(errors, [], "opening the popup must not throw");
    const suggestions = page.locator("#matches-list .item-card");
    await expect(suggestions).toHaveCount(2);
    for (const { username, password } of accounts) {
      await suggestions.filter({ hasText: username }).getByRole("button", { name: "Fill", exact: true }).click();
      await expect(form.getByLabel("Username")).toHaveValue(username);
      await expect(form.getByLabel("Password")).toHaveValue(password);
    }
    assert.deepEqual(await page.evaluate(() => window.testMessages
      .filter(({ type }) => type === "fill-active-tab")
      .map(({ loginIndex, revision, expectedOrigin, objectIdHex }) => ({ loginIndex, revision, expectedOrigin, objectIdHex }))), [
      { loginIndex: 0, revision: "2", expectedOrigin: "https://example.com", objectIdHex: "abcd" },
      { loginIndex: 1, revision: "2", expectedOrigin: "https://example.com", objectIdHex: "abcd" },
    ]);

    const nav = page.locator(".nav-btn");
    await nav.filter({ hasText: "Generator" }).click();
    await expect(page.locator("#gen-output")).not.toBeEmpty();
    await page.getByRole("button", { name: "Passphrase", exact: true }).click();
    await expect(page.getByRole("slider", { name: "Words", exact: true })).toBeVisible();
    await expect(page.locator("#gen-output")).not.toBeEmpty();

    await nav.filter({ hasText: "Settings" }).click();
    await expect(page.getByRole("button", { name: "Sync Vault Now" })).toBeVisible();
    await nav.filter({ hasText: "Vault" }).click();
    await page.locator("#btn-new-login").click();
    const websites = page.getByLabel("Website URLs (one per line)");
    await expect(websites).toHaveValue("https://example.com/login");
    await page.getByLabel("Title", { exact: true }).fill("Test login");
    await websites.fill("https://example.com/login\nhttps://other.example/login");
    await page.locator("#btn-editor-save").click();
    await expect(page.locator("#toast")).toHaveText("Login saved");
    const saved = await page.evaluate(() => window.testMessages.find(({ type }) => type === "save-credential").input);
    assert.equal(saved.url, "https://example.com/login");
    assert.deepEqual(saved.urls, ["https://example.com/login", "https://other.example/login"]);
    assert.deepEqual(errors, []);
  } finally {
    setServiceWorkerDepsForTest({});
    await browser.close();
  }
});
