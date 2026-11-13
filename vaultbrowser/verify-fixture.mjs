// Synthetic UI + real document encryption. Not actual II/vetKD acceptance.
import assert from "node:assert/strict";
import { chromium } from "../wikibrowser/node_modules/@playwright/test/index.mjs";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [],
    external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" && url.protocol !== "blob:") {
      external.push(url.origin);
      return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    window.syntheticBlobEvents = [];
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.syntheticBlobEvents.push(["create", url]);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.syntheticBlobEvents.push(["revoke", url]);
      return revoke(url);
    };
  });
  await page.goto(
    process.env.VAULT_FIXTURE_URL ?? "http://127.0.0.1:3023/?state=opened",
  );
  const title = page.getByLabel("Document title");
  await title.waitFor();
  await page
    .getByRole("button", { name: "Synthetic private note", exact: true })
    .click();
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await editor.getByText("Private fixture text", { exact: true }).waitFor();
  await title.fill("Edited secret");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(
    "\n![private](https://example.invalid/private)\n[link](https://example.invalid/link)",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await editor.evaluate((e) => e === document.activeElement),
    false,
  );
  const preview = page.getByText("Private Markdown preview", { exact: true });
  await preview.focus();
  await page.keyboard.press("Enter");
  assert.equal(await preview.evaluate((e) => e.parentElement.open), true);
  assert.equal(
    await page
      .locator(
        '[aria-label="Private documents"] img,[aria-label="Private documents"] a[href]',
      )
      .count(),
    0,
  );
  await page.getByText("Refresh Vaults", { exact: true }).click();
  assert.equal(await title.inputValue(), "Edited secret");
  await page.getByText("Save document", { exact: true }).click();
  await page
    .getByRole("button", { name: "Edited secret", exact: true })
    .click();
  await editor.getByText("Private fixture text", { exact: true }).waitFor();
  await page.getByText("Show version history", { exact: true }).click();
  const historyDownload = page.waitForEvent("download");
  await page.getByText("Download revision 1", { exact: true }).click();
  const historyFile = await historyDownload;
  assert.match(
    historyFile.suggestedFilename(),
    /^document-[A-Za-z0-9_-]+-revision-1\.bin$/,
  );
  const historyStream = await historyFile.createReadStream();
  const historyChunks = [];
  for await (const chunk of historyStream) historyChunks.push(chunk);
  assert.equal(Buffer.concat(historyChunks).toString(), "Private fixture text");
  await page.evaluate(() => {
    window.retainedEditor = window.syntheticEditor();
    window.retainedInput = document.querySelector('input[maxlength="512"]');
  });
  await page.getByText("Close Vault", { exact: true }).click();
  await page.getByText("Choose or create a Vault", { exact: true }).waitFor();
  const wiped = await page.evaluate(() => ({
    text: window.retainedEditor.state.doc.toString(),
    input: window.retainedInput.value,
    root: !!window.syntheticVault.session.root,
    blobs: window.syntheticBlobEvents,
  }));
  assert.equal(wiped.text, "");
  assert.equal(wiped.input, "");
  assert.equal(wiped.root, false);
  assert.equal(wiped.blobs.filter(([action]) => action === "create").length, 1);
  for (const [, url] of wiped.blobs.filter(([action]) => action === "create"))
    assert(
      wiped.blobs.some(
        ([action, value]) => action === "revoke" && value === url,
      ),
    );
  await page.getByText("Vault 1 · Active", { exact: true }).click();
  await title.waitFor();
  await page.locator('.cm-content[contenteditable="true"]').click();
  await page.keyboard.press("ControlOrMeta+z");
  assert.equal(
    await page.evaluate(() => window.syntheticEditor().state.doc.toString()),
    "",
  );
  await page.getByLabel("Document type").selectOption("credential");
  await page.getByLabel("Password", { exact: true }).fill("credential secret");
  await page.evaluate(() => {
    window.retainedPassword = document.querySelector('input[type="password"]');
  });
  await page.getByText("Close Vault", { exact: true }).click();
  assert.equal(await page.evaluate(() => window.retainedPassword.value), "");
  await page.getByText("Vault 1 · Active", { exact: true }).click();
  await title.waitFor();
  await page.getByLabel("Document type").selectOption("attachment");
  await page.getByLabel("Attachment (10 MiB maximum)").setInputFiles({
    name: "private.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("private file"),
  });
  await page.evaluate(() => {
    window.retainedFile = document.querySelector('input[type="file"]');
  });
  await page.getByText("Close Vault", { exact: true }).click();
  assert.equal(await page.evaluate(() => window.retainedFile.files.length), 0);
  assert.equal(
    await page
      .getByText(/This release has no backup or independent recovery/)
      .isVisible(),
    true,
  );
  await page.getByText("Account & storage", { exact: true }).click();
  assert.equal(
    await page.getByText("Get quote", { exact: true }).isDisabled(),
    true,
  );
  await page.setViewportSize({ width: 375, height: 812 });
  const toggle = page.getByRole("button", { name: "Toggle Vault navigation" });
  assert.equal(await toggle.isVisible(), true);
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(
    await page.getByText("Vault 1 · Active", { exact: true }).isVisible(),
    false,
  );
  assert.equal(
    await page
      .getByText(/This release has no backup or independent recovery/)
      .isVisible(),
    true,
  );
  await toggle.click();
  await page.getByRole("button", { name: "Vault 1 · Active" }).click();
  await title.waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(
    await toggle.evaluate((e) => e === document.activeElement),
    true,
  );
  await title.fill("mobile private draft");
  await toggle.click();
  assert.equal(await title.inputValue(), "mobile private draft");
  await page.getByRole("button", { name: "Vault 2 · Active" }).click();
  await title.waitFor();
  assert.equal(await title.inputValue(), "");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await page.getByText("Close Vault", { exact: true }).click();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "PASS: encrypted save/read fixture, keyboard exit/preview, refresh preservation, history download, DOM/editor undo/password/File/Blob wipe, visible loss disclosure, funding disabled, mobile navigation/focus/draft isolation; 0 page errors, 0 external requests. Synthetic UI only.",
  );
} finally {
  await browser.close();
}
