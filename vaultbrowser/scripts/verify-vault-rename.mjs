// Synthetic UI only: no real canister, identity or funds.
import assert from "node:assert/strict";
import { chromium, expect } from "../../wikibrowser/node_modules/@playwright/test/index.mjs";

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(process.env.VAULT_FIXTURE_URL ?? "http://127.0.0.1:3027");
    const navigation = page.getByRole("button", { name: "Toggle Vault navigation", exact: true });
    const showVaults = async () => {
      if (await navigation.getAttribute("aria-expanded") === "false") await navigation.click();
      await expect(page.getByRole("region", { name: "Vaults" })).toBeVisible();
    };
    await navigation.waitFor();
    assert.equal(await page.evaluate(() => !!window.syntheticNetwork), true, "Synthetic fixture required");
    await showVaults();
    const rename = async (name, next) => {
      const trigger = page.getByRole("button", { name: `Actions for ${name}`, exact: true });
      await trigger.focus(); await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Rename Vault", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Rename Vault", exact: true });
      await expect(dialog.getByText("Use up to 64 characters. Vault names are not encrypted.", { exact: true })).toBeVisible();
      await dialog.getByLabel("Vault name").fill(next);
      await dialog.getByRole("button", { name: "Save name", exact: true }).click();
      await expect(page.getByRole("button", { name: next, exact: true })).toBeVisible();
    };
    await rename("Vault 1", "仕事");
    assert.equal(await page.evaluate(() => !!window.syntheticVault.session.root), false, "Rename must not retrieve a root");
    await page.getByRole("button", { name: "Refresh Vaults", exact: true }).click();
    await expect(page.getByRole("button", { name: "仕事", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "仕事", exact: true }).click();
    await page.getByLabel("Document title").fill("Unsaved note");
    await page.evaluate(() => { window.renameRoot = window.syntheticVault.session.root; });
    await showVaults();
    await rename("仕事", "個人メモ");
    await expect(page.getByLabel("Document title")).toHaveValue("Unsaved note");
    assert.equal(await page.evaluate(() => window.renameRoot === window.syntheticVault.session.root), true, "Rename must preserve the active key");
    const trigger = page.getByRole("button", { name: "Actions for 個人メモ", exact: true });
    await trigger.click(); await page.getByRole("menuitem", { name: "Rename Vault", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Rename Vault", exact: true });
    await dialog.getByLabel("Vault name").fill("x".repeat(65));
    await expect(dialog.getByRole("button", { name: "Save name", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("menuitem", { name: "Vault settings", exact: true }).click();
    await expect(page.getByLabel("Type 個人メモ to confirm", { exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: rename before opening, refreshed name, retained draft/key, length validation, cancel/focus, settings name`);
    await page.close();
  }
} finally { await browser.close(); }
