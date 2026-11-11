import assert from "node:assert/strict";
import { chromium } from "../wikibrowser/node_modules/@playwright/test/index.mjs";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
    }),
    errors = [],
    external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (u.hostname !== "127.0.0.1" && u.protocol !== "blob:") {
      external.push(u.origin);
      return r.abort();
    }
    return r.continue();
  });
  await page.goto("http://127.0.0.1:3023/recovery.html");
  await page
    .getByRole("button", {
      name: "Create a new empty Vault with scoped access",
    })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "Save and verify empty Vault kit",
      exact: true,
    })
    .click();
  const saved = await download;
  await page.getByLabel("Reselect saved empty Vault kit").setInputFiles({
    name: "wrong.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await page
    .getByRole("button", { name: "Resume with saved empty Vault kit" })
    .waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.recoveryFixture.operations),
    ["CreateEmptyStage"],
  );
  await page
    .getByRole("button", { name: "Resume with saved empty Vault kit" })
    .click();
  await page
    .getByLabel("Reselect saved empty Vault kit")
    .setInputFiles(await saved.path());
  await page
    .getByRole("button", { name: "Activate new empty Vault", exact: true })
    .waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.recoveryFixture.operations),
    ["CreateEmptyStage", "CreateEmptyConfirmKit"],
  );
  await page
    .getByRole("button", { name: "Activate new empty Vault", exact: true })
    .click();
  await page
    .getByText(
      "Empty Vault created. Unlock it with a fresh passkey verification.",
      { exact: true },
    )
    .waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.recoveryFixture.operations),
    ["CreateEmptyStage", "CreateEmptyConfirmKit", "CreateEmptyActivate"],
  );
  await page
    .getByRole("button", { name: "Respond to a compromised passkey" })
    .click();
  const commit = page.getByRole("button", {
    name: "Commit all verified targets with fresh passkey proof",
  });
  await commit.waitFor();
  assert.equal(await commit.isEnabled(), true);
  await page.evaluate(() => window.recoveryFixture.replaceOriginal(false));
  await page
    .getByRole("button", { name: "Refresh incident", exact: true })
    .click();
  assert.equal(
    await commit.isDisabled(),
    true,
    "A purging original cannot be treated as resolved",
  );
  await page.evaluate(() => window.recoveryFixture.replaceOriginal(true));
  await page
    .getByRole("button", { name: "Refresh incident", exact: true })
    .click();
  assert.equal(
    await commit.isEnabled(),
    true,
    "A purged original with child plus verified B/C permits whole-job proof",
  );
  assert.equal(
    await page.getByText(/All incident targets committed/).count(),
    0,
  );
  assert.deepEqual(
    await page.evaluate(() => window.recoveryFixture.operations),
    ["CreateEmptyStage", "CreateEmptyConfirmKit", "CreateEmptyActivate"],
  );
  await page.evaluate(() => window.recoveryFixture.invalidate());
  await page
    .getByRole("button", { name: "Refresh incident", exact: true })
    .click();
  assert.equal(await commit.isDisabled(), true);
  await page
    .getByRole("button", { name: "Recover after losing all passkeys" })
    .click();
  await page.getByLabel("Source recovery format").selectOption("legacy");
  const secret = page.getByLabel("Original legacy recovery secret", {
    exact: true,
  });
  await secret.fill("synthetic-private-legacy-secret");
  const retained = await secret.elementHandle();
  await page
    .getByRole("button", { name: "Select source backup and recovery kit" })
    .click();
  await page.getByLabel("Select source encrypted backup").waitFor();
  await page.getByRole("button", { name: "Lock Vault", exact: true }).click();
  assert.equal(await retained.evaluate((el) => el.value), "");
  assert.equal(
    await page.getByLabel("Select source encrypted backup").count(),
    0,
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
    { local: 0, session: 0 },
  );
  await page
    .getByRole("button", { name: "Recover after losing all passkeys" })
    .click();
  await page.screenshot({
    path: ".superpowers/sdd/2026-11-11-wiki-vault/task-16-recovery-ui.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "Synthetic Chromium recovery PASS: actual signed scoped preparation/download/wrong-file rejection/reselection/activation; incident purging/purged-child readiness and remaining-target invalidation; legacy input + pending file lock cleanup; no page errors/external requests/persistent browser storage.",
  );
} finally {
  await browser.close();
}
