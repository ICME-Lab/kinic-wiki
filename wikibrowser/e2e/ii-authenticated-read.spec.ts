import { expect, testWithII } from "@dfinity/internet-identity-playwright";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import type { CDPSession, Page } from "@playwright/test";
import {
  createDatabaseAuthenticated,
  grantDatabaseAccessAuthenticated,
  writeNodeAuthenticated
} from "../lib/vfs-client";

const CANISTER_ID = process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? "";
const II_PROVIDER_URL = process.env.NEXT_PUBLIC_II_PROVIDER_URL ?? "http://id.ai.localhost:8001";
const E2E_PATH = "/Wiki/e2e.md";
const E2E_TITLE = "E2E Private Note";
const E2E_TOKEN = `e2e-private-token-${Date.now()}`;

testWithII.skip(!CANISTER_ID, "NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID is required.");

testWithII.beforeEach(async ({ iiPage }) => {
  await iiPage.waitReady({ url: II_PROVIDER_URL, timeout: 60_000 });
});

testWithII("reads a private database after Internet Identity login", async ({ page, iiPage, browser }) => {
  await installVirtualAuthenticator(page);
  await page.goto("/");
  await createLocalIdentity(page);
  await expect(page.getByRole("heading", { name: "Databases" })).toBeVisible();

  const principal = extractPrincipal(await page.locator("body").innerText());
  const databaseId = await seedPrivateDatabase(principal);
  const privateHref = `/${encodeURIComponent(databaseId)}${E2E_PATH}`;

  const anonymousContext = await browser.newContext();
  const anonymousPage = await anonymousContext.newPage();
  await anonymousPage.goto(privateHref);
  await expect(anonymousPage.getByRole("heading", { name: "Login required" })).toBeVisible();
  await expect(anonymousPage.getByText("Private database")).toBeVisible();
  await anonymousContext.close();

  await page.goto(privateHref);
  await expect(page.getByRole("heading", { name: E2E_TITLE })).toBeVisible();
  await expect(page.getByText(E2E_TOKEN)).toBeVisible();

  await page.goto(`/${encodeURIComponent(databaseId)}/search?q=${encodeURIComponent(E2E_TOKEN)}&kind=full`);
  await expect(page.getByText("principal has no access")).toHaveCount(0);
  await expect(page.getByText(E2E_TOKEN)).toBeVisible();

  await page.goto(`/${encodeURIComponent(databaseId)}/graph?center=${encodeURIComponent(E2E_PATH)}&depth=1`);
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
    content: `# ${E2E_TITLE}\n\n${E2E_TOKEN}\n`,
    metadataJson: "{}",
    expectedEtag: null
  });
  await grantDatabaseAccessAuthenticated(CANISTER_ID, seedIdentity, databaseId, readerPrincipal, "reader");
  return databaseId;
}

function extractPrincipal(text: string): string {
  const match = text.match(/\b[a-z0-9][a-z0-9-]{20,}[a-z0-9]\b/);
  if (!match) {
    throw new Error("Could not find logged-in principal in dashboard text.");
  }
  return match[0];
}

async function createLocalIdentity(page: Page): Promise<void> {
  const iiPopupPromise = page.context().waitForEvent("page");
  await page.locator("[data-tid=login-button]").click();
  const iiPopup = await iiPopupPromise;

  await expect(iiPopup).toHaveTitle("Internet Identity");
  await installVirtualAuthenticator(iiPopup);
  await iiPopup.getByRole("button", { name: "Continue with passkey", exact: true }).click();
  await iiPopup.getByRole("button", { name: "Create new identity", exact: true }).click();

  await iiPopup.getByRole("textbox").fill("Test");
  await iiPopup.getByRole("button", { name: "Create identity", exact: true }).click();

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
