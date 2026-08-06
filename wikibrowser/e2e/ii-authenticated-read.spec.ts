import { expect, testWithII } from "@dfinity/internet-identity-playwright";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import type { CDPSession, Page } from "@playwright/test";
import {
  createDatabaseAuthenticated,
  grantDatabaseAccessAuthenticated,
  writeNodeAuthenticated
} from "../lib/vfs-client";

const CANISTER_ID = process.env.VITE_KINIC_WIKI_CANISTER_ID ?? "";
const II_PROVIDER_URL = process.env.VITE_II_PROVIDER_URL ?? "http://id.ai.localhost:8011";
const E2E_PATH = "/Knowledge/e2e.md";
const E2E_LINKED_PATH = "/Knowledge/e2e-linked.md";
const E2E_TITLE = "E2E Private Note";
const E2E_LINKED_TITLE = "E2E Linked Note";
const E2E_TOKEN = `e2e-private-token-${Date.now()}`;

testWithII.skip(!CANISTER_ID, "VITE_KINIC_WIKI_CANISTER_ID is required.");

testWithII.beforeEach(async ({ iiPage }) => {
  await iiPage.waitReady({ url: II_PROVIDER_URL, timeout: 60_000 });
});

testWithII("reads a private database after Internet Identity login", async ({ page, browser }) => {
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

  const explorer = page.locator('[data-tid="wiki-explorer-panel"]');
  const explorerNoteNames = () => explorer.locator('a[href*="/Knowledge/e2e"]').allTextContents();
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
