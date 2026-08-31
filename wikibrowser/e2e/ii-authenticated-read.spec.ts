import { expect, testWithII } from "@dfinity/internet-identity-playwright";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import type { CDPSession, Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createDatabaseAuthenticated,
  getCyclesBillingConfig,
  grantDatabaseAccessAuthenticated,
  mkdirNodeAuthenticated,
  writeNodeAuthenticated
} from "../lib/vfs-client";

const CANISTER_ID = process.env.VITE_KINIC_WIKI_CANISTER_ID ?? "";
const II_PROVIDER_URL = process.env.VITE_II_PROVIDER_URL ?? "http://id.ai.localhost:8011";
const E2E_PATH = "/Knowledge/e2e.md";
const E2E_LINKED_PATH = "/Knowledge/e2e-linked.md";
const E2E_TITLE = "E2E Private Note";
const E2E_LINKED_TITLE = "E2E Linked Note";
const E2E_TOKEN = `e2e-private-token-${Date.now()}`;
const IMPORT_ROOT_NAME = "folder-import-fixture";
const execFile = promisify(execFileCallback);

testWithII.skip(!CANISTER_ID, "VITE_KINIC_WIKI_CANISTER_ID is required.");

testWithII.beforeEach(async ({ iiPage }) => {
  await iiPage.waitReady({ url: II_PROVIDER_URL, timeout: 60_000 });
});

testWithII("creates and activates a paid second database from Internet Identity without a wallet", async ({ page }) => {
  await installVirtualAuthenticator(page);
  await page.goto("/dashboard");
  await createLocalIdentity(page);
  await expect(page.getByRole("heading", { name: "My databases", exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("kinic-wiki.wallet-session"))).toBeNull();
  const principalLabel = await page.locator('[aria-label^="Principal "]').getAttribute("aria-label");
  const principal = principalLabel?.slice("Principal ".length) ?? "";
  expect(principal).not.toEqual("");
  await seedLocalKinic(principal, 200_000_000n);

  await page.getByRole("button", { name: "Create database", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Create database" });
  await expect(dialog.getByText(/^Requires [0-9,]+ cycles\.$/)).toBeVisible();
  await dialog.getByRole("textbox", { name: "Database name" }).fill(`Free database e2e ${Date.now()}`);
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(page).toHaveURL(/\/db\/db_[a-z0-9]+\/Knowledge$/);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Create database", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Create database" });
  await expect(dialog.getByText("Requires 1.000 KINIC.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Payment source", { exact: true })).toBeVisible();
  await expect(dialog.locator('input[value="ii"]')).toBeChecked();
  await expect(dialog.getByText("Required balance", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Refresh balance", exact: true }).click();
  await expect(dialog.getByText("2.000 KINIC", { exact: true })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Database name" }).fill(`Paid database e2e ${Date.now()}`);
  await expect(dialog.getByRole("button", { name: "Create with Internet Identity", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Create with Internet Identity", exact: true }).click();
  await expect(page).toHaveURL(/\/db\/db_[a-z0-9]+\/Knowledge$/);
});

testWithII("reads a private database after Internet Identity login", async ({ page, browser }, testInfo) => {
  await installVirtualAuthenticator(page);
  await page.goto("/dashboard");
  await createLocalIdentity(page);
  await expect(page.getByRole("heading", { name: "My databases", exact: true })).toBeVisible();

  const principalLabel = await page.locator('[aria-label^="Principal "]').getAttribute("aria-label");
  const principal = principalLabel?.slice("Principal ".length) ?? "";
  expect(principal).not.toEqual("");
  const databaseId = await seedPrivateDatabase(principal);
  const secondDatabaseId = await seedPrivateDatabase(principal);
  const privateHref = `/db/${encodeURIComponent(databaseId)}${E2E_PATH}`;
  const secondPrivateHref = `/db/${encodeURIComponent(secondDatabaseId)}${E2E_PATH}`;

  const anonymousContext = await browser.newContext();
  const anonymousPage = await anonymousContext.newPage();
  await anonymousPage.goto(privateHref);
  await expect(anonymousPage.getByRole("heading", { name: "Login required" })).toBeVisible();
  await expect(anonymousPage.getByText("Private database")).toBeVisible();
  await anonymousContext.close();

  await page.goto(privateHref);
  await expect(page.getByRole("heading", { name: E2E_TITLE })).toBeVisible();
  await expect(page.getByText(E2E_TOKEN)).toBeVisible();

  const markdownImportPath = testInfo.outputPath("selected-local.md");
  const pdfImportPath = testInfo.outputPath("selected-manual.pdf");
  await writeFile(markdownImportPath, "# Selected Markdown\n\nImported as an individual file.\n");
  await writeFile(pdfImportPath, textPdf("Selected PDF text"));

  const explorerPanel = page.locator('[data-tid="wiki-explorer-panel"]');
  await explorerPanel.getByRole("button", { name: "More Explorer actions" }).click();
  await page.getByRole("menuitem", { name: "Import files" }).click();
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([markdownImportPath, pdfImportPath]);
  const fileImportDialog = page.getByRole("dialog", { name: "Import files" });
  await expect(fileImportDialog.getByText("2 selected files")).toBeVisible();
  await fileImportDialog.getByRole("button", { name: "Import 2" }).click();

  await expect(page).toHaveURL(new RegExp(`/Knowledge(?:\\?tab=explorer)?$`));
  await page.goto(`/db/${encodeURIComponent(databaseId)}/Knowledge/selected-local.md`);
  await expect(page.getByRole("heading", { name: "Selected Markdown" })).toBeVisible();
  await expect(page.getByText("Imported as an individual file.")).toBeVisible();
  await page.goto(`/db/${encodeURIComponent(databaseId)}/Knowledge/selected-manual.md`);
  await expect(page.getByText("Selected PDF text")).toBeVisible();
  await page.goto(privateHref);

  const importDirectory = testInfo.outputPath(IMPORT_ROOT_NAME);
  await mkdir(join(importDirectory, "nested"), { recursive: true });
  await writeFile(join(importDirectory, "nested", "local.md"), "# Local Markdown\n\nImported from a local folder.\n");
  await writeFile(join(importDirectory, "manual.pdf"), textPdf("Imported PDF text"));
  await writeFile(join(importDirectory, "existing.md"), "# Replaced content\n");
  await writeFile(join(importDirectory, "image.png"), "not-an-image");

  await explorerPanel.getByRole("button", { name: "More Explorer actions" }).click();
  await page.getByRole("menuitem", { name: "Import folder" }).click();
  await page.locator('input[type="file"][webkitdirectory]').setInputFiles(importDirectory);
  const importDialog = page.getByRole("dialog", { name: "Import folder" });
  await expect(importDialog.getByText("PDF converted")).toBeVisible();
  await expect(importDialog.getByText("1 existing file will be kept unless replacement is selected.")).toBeVisible();
  await expect(importDialog.getByText("Excluded (1)")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(importDialog.getByRole("button", { name: "Import 3" })).toBeVisible();
  await importDialog.getByRole("button", { name: "Import 3" }).click();

  await expect(page).toHaveURL(new RegExp(`/Knowledge/${IMPORT_ROOT_NAME}(?:\\?tab=explorer)?$`));
  await page.goto(`/db/${encodeURIComponent(databaseId)}/Knowledge/${IMPORT_ROOT_NAME}/nested/local.md`);
  await expect(page.getByRole("heading", { name: "Local Markdown" })).toBeVisible();
  await expect(page.getByText("Imported from a local folder.")).toBeVisible();
  await page.goto(`/db/${encodeURIComponent(databaseId)}/Knowledge/${IMPORT_ROOT_NAME}/manual.md`);
  await expect(page.getByRole("heading", { name: "manual" })).toBeVisible();
  await expect(page.getByText("Imported PDF text")).toBeVisible();
  await page.goto(`/db/${encodeURIComponent(databaseId)}/Knowledge/${IMPORT_ROOT_NAME}/existing.md`);
  await expect(page.getByRole("heading", { name: "Existing content" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(privateHref);

  const explorer = page.locator('[data-tid="wiki-explorer-panel"]');
  const explorerNoteNames = () => explorer
    .locator('a[href$="/Knowledge/e2e.md"], a[href$="/Knowledge/e2e-linked.md"]')
    .allTextContents();
  await explorer.getByRole("combobox", { name: "Sort Explorer" }).click();
  await page.getByRole("option", { name: "Name (Z–A)" }).click();
  await expect.poll(explorerNoteNames).toEqual(["e2e.md", "e2e-linked.md"]);
  expect(await page.evaluate(() => window.localStorage.getItem("kinicWikiExplorerSortOrder"))).toBe("name-desc");

  await page.reload();
  await expect(page.getByRole("heading", { name: E2E_TITLE })).toBeVisible();
  await expect.poll(explorerNoteNames).toEqual(["e2e.md", "e2e-linked.md"]);

  await page.goto(secondPrivateHref);
  await expect(page.getByRole("heading", { name: E2E_TITLE })).toBeVisible();
  await expect.poll(explorerNoteNames).toEqual(["e2e.md", "e2e-linked.md"]);
  await page.goto(privateHref);
  await expect(page.getByRole("heading", { name: E2E_TITLE })).toBeVisible();

  await explorer.getByRole("button", { name: "More Explorer actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Move" })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
  await explorer.getByRole("button", { name: "More Explorer actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(explorer.getByRole("textbox", { name: "Rename selected node" })).toHaveValue("e2e.md");
  await explorer.getByRole("button", { name: "Cancel Explorer action" }).click();

  const rscRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("_rsc=") || request.headers()["next-router-prefetch"] === "1") {
      rscRequests.push(request.url());
    }
  });
  await page.getByRole("link", { name: "Open linked note" }).click();
  await expect(page).toHaveURL(new RegExp(`${E2E_LINKED_PATH.replace(".", "\\.")}$`));
  await expect(page.getByRole("heading", { name: E2E_LINKED_TITLE })).toBeVisible();
  expect(rscRequests).toEqual([]);
  await page.goBack();
  await expect(page.getByRole("heading", { name: E2E_TITLE })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: E2E_LINKED_TITLE })).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.locator(".cm-content");
  await editor.click();
  await editor.press("End");
  await editor.pressSequentially(" unsaved");
  await expect(page.getByText("Unsaved", { exact: true }).first()).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname.endsWith(E2E_LINKED_PATH) && url.searchParams.get("view") === "edit");
  await expect(editor).toContainText("unsaved");
  page.once("dialog", (dialog) => dialog.accept());
  await page.goBack();
  await expect(page.getByRole("heading", { name: E2E_TITLE })).toBeVisible();

  await page.goto(`/db/${encodeURIComponent(databaseId)}/search?q=${encodeURIComponent(E2E_TOKEN)}&kind=full`);
  await expect(page.getByText("principal has no access")).toHaveCount(0);
  await expect(page.getByText(E2E_TOKEN)).toBeVisible();

  await page.goto(`/db/${encodeURIComponent(databaseId)}/graph?center=${encodeURIComponent(E2E_PATH)}&depth=1`);
  await expect(page.getByText("principal has no access")).toHaveCount(0);
  await expect(page.getByText("Local link graph")).toBeVisible();
});

testWithII("publishes one node without exposing the private database", async ({ page, browser }) => {
  await installVirtualAuthenticator(page);
  await page.goto("/dashboard");
  await createLocalIdentity(page);
  const principalLabel = await page.locator('[aria-label^="Principal "]').getAttribute("aria-label");
  const principal = principalLabel?.slice("Principal ".length) ?? "";
  expect(principal).not.toEqual("");

  const seedIdentity = Ed25519KeyIdentity.generate();
  const { database_id: databaseId } = await createDatabaseAuthenticated(CANISTER_ID, seedIdentity, `Published node e2e ${Date.now()}`);
  const publishedPath = "/Knowledge/published.md";
  const privatePath = "/Knowledge/private.md";
  const uppercaseMarkdownPath = "/Knowledge/not-publishable.MD";
  const sourcePath = "/Sources/not-publishable.md";
  const firstWrite = await writeNodeAuthenticated(CANISTER_ID, seedIdentity, {
    databaseId,
    path: publishedPath,
    kind: "file",
    content: "# Public note\n\nFirst public version.\n\n[[/Knowledge/private.md|Private reference]]\n\n[External reference](https://example.com/reference)\n",
    metadataJson: "{}",
    expectedEtag: null
  });
  await writeNodeAuthenticated(CANISTER_ID, seedIdentity, {
    databaseId,
    path: privatePath,
    kind: "file",
    content: "# Private note\n\nsecret-node-content",
    metadataJson: "{}",
    expectedEtag: null
  });
  await writeNodeAuthenticated(CANISTER_ID, seedIdentity, {
    databaseId,
    path: uppercaseMarkdownPath,
    kind: "file",
    content: "# Uppercase extension\n",
    metadataJson: "{}",
    expectedEtag: null
  });
  await writeNodeAuthenticated(CANISTER_ID, seedIdentity, {
    databaseId,
    path: sourcePath,
    kind: "source",
    content: "Source content",
    metadataJson: "{}",
    expectedEtag: null
  });
  await grantDatabaseAccessAuthenticated(CANISTER_ID, seedIdentity, databaseId, principal, "owner");

  await page.goto(`/db/${encodeURIComponent(databaseId)}${uppercaseMarkdownPath}`);
  await expect(page.getByRole("heading", { name: "Uppercase extension" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toHaveCount(0);

  await page.goto(`/db/${encodeURIComponent(databaseId)}${sourcePath}`);
  await expect(page.getByText("Source content")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toHaveCount(0);

  await page.goto(`/db/${encodeURIComponent(databaseId)}${publishedPath}`);
  await expect(page.getByRole("heading", { name: "Public note" })).toBeVisible();
  const explorer = page.locator('[data-tid="wiki-explorer-panel"]');
  await expect(explorer.getByLabel("Published")).toHaveCount(0);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  let publicationDialog = page.getByRole("dialog", { name: "Publish page?" });
  await expect(publicationDialog).toBeVisible();
  await expect(publicationDialog.getByText(publishedPath, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Published", exact: true })).toHaveCount(0);
  await expect(explorer.getByLabel("Published")).toHaveCount(0);
  await publicationDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(publicationDialog).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Published", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  publicationDialog = page.getByRole("dialog", { name: "Publish page?" });
  await publicationDialog.getByRole("button", { name: "Publish" }).click();
  const publishedLink = page.getByRole("link", { name: "Published", exact: true });
  await expect(publishedLink).toBeVisible();
  await expect(explorer.getByLabel("Published")).toBeVisible();
  const publicPath = await publishedLink.getAttribute("href");
  expect(publicPath).toMatch(/^\/p\/[0-9a-f]{32}$/);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy public link" }).click();
  const copiedLink = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(copiedLink).pathname).toEqual(publicPath);

  const anonymousContext = await browser.newContext();
  const anonymousPage = await anonymousContext.newPage();
  await anonymousPage.goto(publicPath!);
  await expect(anonymousPage.getByRole("heading", { name: "Public note" }).first()).toBeVisible();
  await expect(anonymousPage.getByText("First public version.")).toBeVisible();
  await expect(anonymousPage.getByText("Private reference")).toBeVisible();
  await expect(anonymousPage.getByRole("link", { name: "Private reference" })).toHaveCount(0);
  await expect(anonymousPage.getByRole("link", { name: "External reference" })).toHaveAttribute("href", "https://example.com/reference");
  await expect(anonymousPage.getByText("secret-node-content")).toHaveCount(0);

  await writeNodeAuthenticated(CANISTER_ID, seedIdentity, {
    databaseId,
    path: publishedPath,
    kind: "file",
    content: "# Public note\n\nUpdated public version.\n",
    metadataJson: "{}",
    expectedEtag: firstWrite.node.etag
  });
  await anonymousPage.reload();
  await expect(anonymousPage.getByText("Updated public version.")).toBeVisible();

  for (const role of ["reader", "writer"] as const) {
    await grantDatabaseAccessAuthenticated(CANISTER_ID, seedIdentity, databaseId, principal, role);
    await page.reload();
    await expect(page.getByRole("link", { name: "Published", exact: true })).toBeVisible();
    await expect(page.locator('[data-tid="wiki-explorer-panel"]').getByLabel("Published")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy public link" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Unpublish" })).toHaveCount(0);
  }

  await grantDatabaseAccessAuthenticated(CANISTER_ID, seedIdentity, databaseId, principal, "owner");
  await page.reload();
  await page.getByRole("button", { name: "Unpublish" }).click();
  publicationDialog = page.getByRole("dialog", { name: "Unpublish page?" });
  await expect(publicationDialog).toBeVisible();
  await expect(publicationDialog.getByText(publishedPath, { exact: true })).toBeVisible();
  await anonymousPage.reload();
  await expect(anonymousPage.getByText("Updated public version.")).toBeVisible();
  await publicationDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(publicationDialog).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Published", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Unpublish" }).click();
  publicationDialog = page.getByRole("dialog", { name: "Unpublish page?" });
  await publicationDialog.getByRole("button", { name: "Unpublish" }).click();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  await expect(page.locator('[data-tid="wiki-explorer-panel"]').getByLabel("Published")).toHaveCount(0);
  await anonymousPage.reload();
  await expect(anonymousPage.getByRole("heading", { name: "Not found" })).toBeVisible();
  await anonymousContext.close();
});

async function seedLocalKinic(recipientPrincipal: string, amountE8s: bigint): Promise<void> {
  const config = await getCyclesBillingConfig(CANISTER_ID);
  const argument = `(record {
    to = record { owner = principal "${recipientPrincipal}"; subaccount = null };
    fee = null;
    memo = null;
    from_subaccount = null;
    created_at_time = null;
    amount = ${amountE8s} : nat
  })`;
  await execFile(
    "icp",
    ["canister", "call", config.kinicLedgerCanisterId, "icrc1_transfer", argument, "-e", process.env.ICP_ENVIRONMENT ?? "local-wiki", "-o", "candid"],
    { maxBuffer: 1024 * 1024 }
  );
}

async function seedPrivateDatabase(readerPrincipal: string): Promise<string> {
  const seedIdentity = Ed25519KeyIdentity.generate();
  const { database_id: databaseId } = await createDatabaseAuthenticated(CANISTER_ID, seedIdentity, `II e2e ${Date.now()}`);
  await writeNodeAuthenticated(CANISTER_ID, seedIdentity, {
    databaseId,
    path: E2E_PATH,
    kind: "file",
    content: `# ${E2E_TITLE}\n\n${E2E_TOKEN}\n\n[Open linked note](./e2e-linked.md)\n`,
    metadataJson: "{}",
    expectedEtag: null
  });
  await writeNodeAuthenticated(CANISTER_ID, seedIdentity, {
    databaseId,
    path: E2E_LINKED_PATH,
    kind: "file",
    content: `# ${E2E_LINKED_TITLE}\n`,
    metadataJson: "{}",
    expectedEtag: null
  });
  await mkdirNodeAuthenticated(CANISTER_ID, seedIdentity, {
    databaseId,
    path: `/Knowledge/${IMPORT_ROOT_NAME}`
  });
  await writeNodeAuthenticated(CANISTER_ID, seedIdentity, {
    databaseId,
    path: `/Knowledge/${IMPORT_ROOT_NAME}/existing.md`,
    kind: "file",
    content: "# Existing content\n",
    metadataJson: "{}",
    expectedEtag: null
  });
  await grantDatabaseAccessAuthenticated(CANISTER_ID, seedIdentity, databaseId, readerPrincipal, "writer");
  return databaseId;
}

async function createLocalIdentity(page: Page): Promise<void> {
  const iiPopupPromise = page.context().waitForEvent("page");
  await page.locator("[data-tid=login-button]").click();
  const iiPopup = await iiPopupPromise;

  await expect(iiPopup).toHaveTitle("Internet Identity");
  await installVirtualAuthenticator(iiPopup);
  await iiPopup.getByRole("button", { name: "Continue with passkey", exact: true }).click();
  await iiPopup.getByRole("button", { name: "Use existing identity", exact: true }).click();

  const missingIdentity = iiPopup.getByText("Cannot read properties of undefined (reading 'anchor_number')");
  const createNewIdentity = iiPopup.getByRole("button", { name: "Create new identity", exact: true });
  const hasMissingIdentityError = await missingIdentity.waitFor({ state: "visible", timeout: 2_000 }).then(
    () => true,
    () => false
  );
  const canCreateIdentity = await createNewIdentity.waitFor({ state: "visible", timeout: 2_000 }).then(
    () => createNewIdentity.isEnabled(),
    () => false
  );
  if (hasMissingIdentityError || canCreateIdentity) {
    await expect(createNewIdentity).toBeEnabled();
    await createNewIdentity.click();
    await iiPopup.getByRole("textbox").fill("Test");
    await iiPopup.getByRole("button", { name: "Create identity", exact: true }).click();
  }

  await iiPopup.getByRole("button", { name: "Continue", exact: true }).click();
  await iiPopup.waitForEvent("close");
}

async function installVirtualAuthenticator(page: Page): Promise<CDPSession> {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true
    }
  });
  return client;
}

function textPdf(text: string): Buffer {
  const stream = `BT\n/F1 16 Tf\n72 720 Td\n(${text.replace(/[()\\]/g, "\\$&")}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}
