import { expect, type Locator, type Page, test } from "@playwright/test";

const APP_STORE_URL = "https://apps.apple.com/us/app/kinicwiki-ai-memory/id6785718977";
const CLIPPER_STORE_URL = "https://chromewebstore.google.com/detail/kinic-wiki-clipper/moebdnadaffhlddnhifmmdoecifhcbdi";
const MOBILE_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 }
] as const;

test("renders the home calls to action and follows internal routes", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "AI memory that keeps its sources." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Every answer has a route back to evidence." })).toBeVisible();
  const memoryMap = page.getByRole("figure", { name: "Every answer has a route back to evidence." });
  for (const stage of ["iOS", "Clipper", "CLI", "/Sources", "/Knowledge", "cited answer", "Dashboard"]) {
    await expect(memoryMap).toContainText(stage);
  }

  const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(primaryNavigation.getByRole("link", { name: "Open Dashboard" })).toHaveAttribute("href", "/dashboard");

  const memoryFlow = page.getByRole("link", { name: "See how it works" });
  await memoryFlow.click();
  await expect(page).toHaveURL(/\/#memory-flow$/);
  await expect(page.getByRole("heading", { name: "Capture the context. Maintain the knowledge. Check the answer." })).toBeVisible();

  await expectExternalLink(page.getByRole("link", { name: "Get the iOS app" }), APP_STORE_URL);
  await expectExternalLink(page.getByRole("link", { name: "Install Clipper" }), CLIPPER_STORE_URL);
  await expect(page.getByRole("link", { name: "Install the CLI" })).toHaveAttribute("href", "/docs/cli");

  await page.getByRole("link", { name: "Read the iOS guide" }).click();
  await expect(page).toHaveURL(/\/docs\/ios$/);
  await expect(page.getByRole("heading", { level: 1, name: "Save from Safari or X with the Share Extension" })).toBeVisible();

  await page.goto("/");
  await page.getByRole("link", { name: "Read the Clipper guide" }).click();
  await expect(page).toHaveURL(/\/docs\/clipper$/);
  await expect(page.getByRole("heading", { level: 1, name: "Save browser context with Wiki Clipper" })).toBeVisible();

  await page.goto("/");
  await primaryNavigation.getByRole("link", { name: "Open Dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("redirects the native authentication hash route", async ({ page }) => {
  await page.goto("/#/native-auth?session=test-session&callback=kinicwiki%3A%2F%2Fauth");

  await expect(page).toHaveURL(/\/native-auth\?session=test-session&callback=kinicwiki%3A%2F%2Fauth$/);
});

test("renders the iOS overview and guide contracts", async ({ page }) => {
  await page.goto("/ios");

  await expect(page).toHaveTitle("KinicWiki for iPhone and iPad | Kinic Wiki");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://wiki.kinic.xyz/ios");
  await expect(page.getByRole("heading", { level: 1, name: "Save what matters, straight to your AI memory." })).toBeVisible();
  await expectExternalLink(page.getByRole("link", { name: "Download on the App Store" }).first(), APP_STORE_URL);
  for (const requirement of [
    "The Share Extension",
    "Safari or a post from X",
    "One shared web URL goes to one database",
    "Owner or Writer",
    "on-device queue",
    "Capture history",
    "Browse what you saved",
    "Ask with the source attached",
    "Internet Identity",
    "Ask AI history stays on your device"
  ]) {
    await expect(page.getByText(requirement, { exact: false }).first()).toBeVisible();
  }

  await page.getByRole("link", { name: "Read the Privacy Policy" }).click();
  await expect(page).toHaveURL(/\/privacy-policy$/);
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();

  await page.goto("/docs/ios");
  await expect(page).toHaveTitle("KinicWiki iOS Setup Guide | Kinic Wiki");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://wiki.kinic.xyz/docs/ios");
  await expect(page.getByRole("heading", { level: 1, name: "Save from Safari or X with the Share Extension" })).toBeVisible();
  await expectExternalLink(page.getByRole("link", { name: "Download on the App Store" }), APP_STORE_URL);
  for (const requirement of [
    "iOS 18 or later",
    "Owner or Writer",
    "Reader access is enough for Browse",
    "one HTTP or HTTPS URL at a time",
    "does not accept image or file shares",
    "available preview text and image metadata",
    "Capture started",
    "Saved for later",
    "Saved, retry required",
    "on-device queue",
    "Capture history",
    "under /Sources",
    "Ask AI is scoped to the database you select",
    "Ask AI history is stored on this device",
    "Generation request data is discarded after processing"
  ]) {
    await expect(page.getByText(requirement, { exact: false }).first()).toBeVisible();
  }

  await page.getByRole("link", { name: "See the app overview" }).click();
  await expect(page).toHaveURL(/\/ios$/);
});

test("renders the Clipper guide, requirements, and docs navigation", async ({ page }) => {
  await page.goto("/docs/clipper");

  await expect(page).toHaveTitle("Kinic Wiki Clipper");
  await expect(page.getByRole("heading", { level: 1, name: "Save browser context with Wiki Clipper" })).toBeVisible();
  await expectExternalLink(page.getByRole("link", { name: "Add to Chrome" }), CLIPPER_STORE_URL);
  for (const requirement of [
    "ChatGPT or Claude session",
    "Clipper Internet Identity session",
    "Dashboard Internet Identity session",
    "same Internet Identity",
    "no destination database is selected",
    "does not have writer access",
    "does not have enough write cycles"
  ]) {
    await expect(page.getByText(requirement, { exact: false }).first()).toBeVisible();
  }

  await page.goto("/docs");
  await page.getByRole("region", { name: "Primary docs" }).getByRole("link", { name: /Wiki Clipper/ }).click();
  await expect(page).toHaveURL(/\/docs\/clipper$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs");
  await page.getByRole("button", { name: "Open admin navigation" }).click();
  await page.getByRole("navigation", { name: "Admin navigation" }).getByRole("link", { name: "iOS App" }).click();
  await expect(page).toHaveURL(/\/docs\/ios$/);
});

for (const viewport of MOBILE_VIEWPORTS) {
  test(`keeps public calls to action visible at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const cases = [
      { path: "/", name: "Install Clipper" },
      { path: "/ios", name: "Download on the App Store" },
      { path: "/docs/ios", name: "Download on the App Store" },
      { path: "/docs/clipper", name: "Add to Chrome" }
    ];

    for (const entry of cases) {
      await page.goto(entry.path);
      const callToAction = page.getByRole("link", { name: entry.name }).first();
      await expectActionableWithinViewport(page, callToAction);
      await expectNoHorizontalOverflow(page);
    }
  });
}

async function expectExternalLink(link: Locator, href: string) {
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", href);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /(?:^|\s)noopener(?:\s|$)/);
  await expect(link).toHaveAttribute("rel", /(?:^|\s)noreferrer(?:\s|$)/);
  await link.click({ trial: true });
}

async function expectActionableWithinViewport(page: Page, link: Locator) {
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeVisible();
  await link.click({ trial: true });
  const box = await link.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}
