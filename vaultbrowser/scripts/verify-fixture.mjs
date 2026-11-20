// Synthetic UI + real document encryption. Not actual II/vetKD acceptance.
import assert from "node:assert/strict";
import { chromium, expect } from "../../wikibrowser/node_modules/@playwright/test/index.mjs";
import { showVaultNavigation } from "./acceptance-ui.mjs";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  async function acceptDiscard(){const dialog=page.getByRole("dialog",{name:"Discard unsaved changes?"});if(await dialog.count())await dialog.getByRole("button",{name:"Discard changes"}).click();}
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
  assert.equal(await page.locator("summary").filter({ hasText: "Account & storage" }).isVisible(), false);
  await showVaultNavigation(page);
  await page.getByRole("button", { name: "Actions for Vault 1", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage members", exact: true }).click();
  await page.getByText("No additional members.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Back to Vault", exact: true }).click();
  assert.equal(await page.getByRole("searchbox").count(), 0);
  assert.equal(await page.getByRole("heading", { name: "Private documents", exact: true }).count(), 0);
  const documentList = page.locator(".vault-document-list");
  const newDocument = documentList.getByRole("button", { name: "New document", exact: true });
  await expect(newDocument).toBeVisible();
  await expect(newDocument).toHaveText("");
  await expect(documentList.getByRole("button", { name: "Welcome note", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh documents", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh Vaults", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Welcome note", exact: true }).click();
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await editor.getByText("Your private notes belong here.", { exact: true }).waitFor();
  await title.fill("Edited secret");
  const toggle = page.getByRole("button", { name: "Toggle Vault navigation" });
  const frame = page.locator(".vault-editor-frame");
  const editorWidth = (await frame.boundingBox()).width;
  await expect(page.locator(".vault-switcher-slot").getByRole("button", { name: "Toggle Vault navigation" })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Create Vault", exact: true })).toBeVisible();
  assert.equal((await frame.boundingBox()).width, editorWidth);
  await toggle.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  assert.equal(await title.inputValue(), "Edited secret");
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
  const preview = page.getByRole("button", { name: "Preview", exact: true });
  const edit = page.getByRole("button", { name: "Edit", exact: true });
  await page.evaluate(() => { window.beforePreviewEditor = window.syntheticEditor(); });
  await preview.press("Enter");
  await expect(preview).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeHidden();
  await expect(page.locator(".vault-preview-pane")).toContainText("Your private notes belong here.");
  assert.equal(
    await page
      .locator(
        '[aria-label="Private documents"] img,[aria-label="Private documents"] a[href]',
      )
      .count(),
    0,
  );
  await edit.press("Enter");
  await expect(editor).toBeVisible();
  assert.equal(await page.evaluate(() => window.beforePreviewEditor === window.syntheticEditor()), true);
  await page.getByRole("button", { name: "Refresh Vaults", exact: true }).click();
  assert.equal(await title.inputValue(), "Edited secret");
  const savedText = await editor.innerText();
  await page.evaluate(() => { window.beforeSaveEditor = window.syntheticEditor(); });
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.waitForFunction(() => {
    const title = document.querySelector('input[maxlength="512"]');
    return title && !title.disabled;
  });
  assert.equal(await title.inputValue(), "Edited secret");
  assert.equal(await editor.innerText(), savedText);
  assert.equal(await page.evaluate(() => window.beforeSaveEditor === window.syntheticEditor()), true);
  assert.equal(await page.getByRole("button", { name: "Save document", exact: true }).isDisabled(), true);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\nFurther edits after saving");
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('input[maxlength="512"]').disabled);
  assert.match(await editor.innerText(), /Further edits after saving/);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\nDiscard this draft");
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  assert.match(await editor.innerText(), /Further edits after saving/);
  assert.doesNotMatch(await editor.innerText(), /Discard this draft/);
  await page
    .getByRole("button", { name: "Edited secret", exact: true })
    .click();
  await editor.getByText("Your private notes belong here.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Show version history", exact: true }).click();
  const historyDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "View revision 1", exact: true }).click();
  await page.getByRole("button", { name: "Download document", exact: true }).click();
  const historyFile = await historyDownload;
  assert.match(
    historyFile.suggestedFilename(),
    /^document-[A-Za-z0-9_-]+-revision-1\.bin$/,
  );
  const historyStream = await historyFile.createReadStream();
  const historyChunks = [];
  for await (const chunk of historyStream) historyChunks.push(chunk);
  assert.equal(Buffer.concat(historyChunks).toString(), "Your private notes belong here.");
  await page.evaluate(() => {
    window.retainedEditor = window.syntheticEditor();
    window.retainedInput = document.querySelector('input[maxlength="512"]');
  });
  await page.getByText("Close Vault", { exact: true }).click();
  await acceptDiscard();
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
  await showVaultNavigation(page);
  await page.getByRole("button", { name: "Vault 1", exact: true }).click();
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
  await acceptDiscard();
  assert.equal(await page.evaluate(() => window.retainedPassword.value), "");
  await showVaultNavigation(page);
  await page.getByRole("button", { name: "Vault 1", exact: true }).click();
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
  await acceptDiscard();
  assert.equal(await page.evaluate(() => window.retainedFile.files.length), 0);
  assert.equal(
    await page
      .getByText(/This release has no backup or independent recovery/)
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Account settings", exact: true }).click();
  await page.locator("summary").filter({ hasText: "Account & storage" }).waitFor({ state: "visible" });
  await page.locator("summary").filter({ hasText: "Account & storage" }).click();
  assert.equal(
    await page.getByRole("button", { name: "Review payment", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Back to Vault", exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await toggle.isVisible(), true);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  assert.equal(
    await page.getByText("Vault 1", { exact: true }).isVisible(),
    false,
  );
  assert.equal(
    await page
      .getByText(/This release has no backup or independent recovery/)
      .count(),
    0,
  );
  await toggle.click();
  await page.getByRole("button", { name: "Vault 1", exact: true }).click();
  await title.waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(
    await toggle.evaluate((e) => e === document.activeElement),
    true,
  );
  await title.fill("mobile private draft");
  await toggle.click();
  assert.equal(await title.inputValue(), "mobile private draft");
  await page.getByRole("button", { name: "Vault 2", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await title.inputValue(), "mobile private draft");
  await page.getByRole("button", { name: "Vault 2", exact: true }).click();
  await acceptDiscard();
  await title.waitFor();
  assert.equal(await title.inputValue(), "");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await page.getByText("Close Vault", { exact: true }).click();
  await acceptDiscard();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "PASS: encrypted save/read fixture, keyboard exit/preview, refresh preservation, history download, DOM/editor undo/password/File/Blob wipe, funding disabled, desktop and mobile navigation/focus/draft isolation; 0 page errors, 0 external requests. Synthetic UI only.",
  );
} finally {
  await browser.close();
}
