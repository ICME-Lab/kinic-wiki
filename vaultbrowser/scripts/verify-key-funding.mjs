// Synthetic browser fixture: real React/client preflight, no real funds or vetKD.
import assert from "node:assert/strict";
import { chromium, expect } from "../../wikibrowser/node_modules/@playwright/test/index.mjs";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const origin = process.env.VAULT_FIXTURE_URL ?? "http://127.0.0.1:3137";
  await page.goto(`${origin}/?state=fresh`);
  await expect(page.getByRole("button", { name: "Create your Vault", exact: true })).toBeEnabled();
  await expect(page.getByText(/free cycles granted once/)).toHaveCount(0);
  await expect(page.getByText(/Your first key retrieval is included|Getting a key on a new browser/)).toHaveCount(0);
  await page.getByRole("button", { name: "Create your Vault", exact: true }).click();
  await expect(page.getByLabel("Document title")).toBeVisible();
  await page.getByRole("button", { name: "Toggle Vault navigation" }).click();
  await expect(page.getByRole("button", { name: "Create Vault", exact: true })).toBeDisabled();
  assert.equal(await page.evaluate(() => window.syntheticNetwork.creation.length), 1);
  await page.goto(`${origin}/?state=key-funding`);
  // Mobile navigation is collapsed: reveal it so the fixture's synthetic click
  // has the same accessible target as a user selecting the existing Vault.
  await page.getByRole("button", { name: "Toggle Vault navigation" }).click();
  await page.getByRole("button", { name: "Vault 1", exact: true }).click();
  const panel = page.getByRole("region", { name: "Open Vault" });
  await expect(panel.getByLabel("KINIC amount")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry opening Vault" })).toBeDisabled();
  assert.equal(await page.evaluate(() => !!window.syntheticVault.session.root), false);
  assert.equal(await page.evaluate(() => window.syntheticNetwork.creation.length), 0);
  // Simulate a credited payment; actual payment/ledger behavior is tested in Wasm.
  await page.evaluate(() => window.syntheticNetwork.setBalance(50_000_000_000n));
  await page.getByRole("button", { name: "Account settings", exact: true }).click();
  await page.locator("summary").filter({ hasText: "Account & storage" }).click();
  await page.getByRole("button", { name: "Refresh balance", exact: true }).click();
  await page.getByRole("button", { name: "Back to Vault", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry opening Vault" })).toBeEnabled();
  await page.getByRole("button", { name: "Retry opening Vault" }).click();
  await expect(page.getByLabel("Document title")).toBeVisible();
  assert.equal(await page.evaluate(() => window.syntheticNetwork.creation.length), 0);
  console.log("PASS: mobile 10B first-use includes its key, later creation needs funding; missing-key funding stays inline and retries the same Vault. Synthetic UI only.");
} finally {
  await browser.close();
}
