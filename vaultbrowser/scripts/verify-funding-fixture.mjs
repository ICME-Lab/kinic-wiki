// Synthetic Funding behavior only. This is not ledger/II acceptance evidence.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "../../wikibrowser/node_modules/@playwright/test/index.mjs";
const base =
  process.env.VAULT_FIXTURE_URL ?? "http://127.0.0.1:3033/?state=funding";
const artifacts =
  process.env.VAULT_FUNDING_ARTIFACTS ?? "/private/tmp/vault-funding-fixture";
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [],
      external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== "127.0.0.1" && url.protocol !== "blob:") {
        external.push(url.origin);
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(base);
    const scan = page.getByRole("button", {
      name: "Scan ledger for this payment",
      exact: true,
    });
    await scan.waitFor();
    assert.equal(await page.evaluate(() => window.syntheticFunding.calls), 0);
    await scan.click();
    const resume = page.getByRole("button", {
      name: "Resume ledger scan",
      exact: true,
    });
    await page.waitForFunction(() => window.syntheticFunding.calls === 10);
    await page.getByText(/next 1000 of 1500/).waitFor();
    assert.equal(await resume.isEnabled(), true);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.syntheticFunding.calls), 10);
    assert.equal(await page.evaluate(() => window.syntheticFunding.funded), 0);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: `${artifacts}/funding-${viewport.width}-resume.png`,
      fullPage: true,
    });
    await resume.click();
    await page.getByText("Paid", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.syntheticFunding.calls), 15);
    assert.equal(await page.evaluate(() => window.syntheticFunding.funded), 1);
    await page.reload();
    await page
      .getByRole("button", {
        name: "Scan ledger for this payment",
        exact: true,
      })
      .click();
    await page.waitForFunction(() => window.syntheticFunding.calls === 1);
    await page
      .getByRole("button", { name: "Stop ledger scan", exact: true })
      .click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.syntheticFunding.calls), 1);
    assert.equal(await page.evaluate(() => window.syntheticFunding.funded), 0);
    assert.equal(
      await page.getByText("Unknown", { exact: true }).isVisible(),
      true,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    await page.close();
  }
  console.log(
    JSON.stringify({
      synthetic: true,
      viewports: [1280, 390],
      maxCallsPerClick: 10,
      resumedCalls: 15,
      stoppedCalls: 1,
      artifacts,
    }),
  );
} finally {
  await browser.close();
}
