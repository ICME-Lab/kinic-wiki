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
  const privateHref = `/db/${encodeURIComponent(databaseId)}${E2E_PATH}`;

  const anonymousContext = await browser.newContext();
  const anonymousPage = await anonymousContext.newPage();
  await anonymousPage.goto(privateHref);
  await expect(anonymousPage.getByRole("heading", { name: "Login required" })).toBeVisible();
  await expect(anonymousPage.getByText("Private database")).toBeVisible();
  await anonymousContext.close();

  await page.goto(privateHref);
  await expect(page.getByRole("heading", { name: E2E_TITLE })).toBeVisible();
  await expect(page.getByText(E2E_TOKEN)).toBeVisible();

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
  const needsIdentity = await missingIdentity.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false);
  if (needsIdentity) {
    await iiPopup.getByRole("button", { name: "Create new identity", exact: true }).click();
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
