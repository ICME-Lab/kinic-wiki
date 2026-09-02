import { expect, type Page, test } from "@playwright/test";

test("renders the support route with metadata, navigation, and isolated external links", async ({ page }) => {
  await page.goto("/support");

  await expect(page).toHaveTitle("Support | Kinic Wiki");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "Get help with Kinic Wiki and the Kinic Wiki ChatGPT app."
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://wiki.kinic.xyz/support");
  await expect(page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible();
  await expectSectionLinksToResolve(page, "Support sections");

  await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy-policy");
  const externalContacts = page.getByRole("link", { name: "https://x.com/kinic_app" });
  expect(await externalContacts.count()).toBeGreaterThan(0);
  for (const externalContact of await externalContacts.all()) {
    await expect(externalContact).toHaveAttribute("href", "https://x.com/kinic_app");
    await expect(externalContact).toHaveAttribute("target", "_blank");
    await expect(externalContact).toHaveAttribute("rel", /(?:^|\s)noreferrer(?:\s|$)/);
    await expect(externalContact).toHaveAttribute("rel", /(?:^|\s)noopener(?:\s|$)/);
  }
});

test("renders the privacy policy from its legal source", async ({ page }) => {
  await page.goto("/privacy-policy");

  await expect(page).toHaveTitle("Privacy Policy | Kinic Wiki");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "How Kinic processes, stores, protects, and retains information across Kinic Wiki and Ask AI."
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://wiki.kinic.xyz/privacy-policy");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(11);
  const policy = page.getByRole("article");
  await expect(policy).toContainText("Last Updated: August 5, 2026");
  await expect(policy).toContainText("Effective Date: August 5, 2026");
  await expectSectionLinksToResolve(page, "Privacy Policy sections");
});

test("publishes all public routes in the sitemap", async ({ request }) => {
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.ok()).toBe(true);
  const body = await sitemap.text();
  for (const path of [
    "/",
    "/ios",
    "/docs/ios",
    "/docs/clipper",
    "/docs/skills/query",
    "/docs/skills/edit",
    "/docs/skills/mcp",
    "/docs/skills/ingest",
    "/docs/skills/lint",
    "/docs/skills/context-pack",
    "/docs/skills/registry",
    "/privacy-policy",
    "/support"
  ]) {
    expect(body).toContain(`<loc>https://wiki.kinic.xyz${path}</loc>`);
  }
});

async function expectSectionLinksToResolve(page: Page, navigationName: string) {
  const sectionLinks = page.locator(`nav[aria-label="${navigationName}"]:visible a`);
  const linkCount = await sectionLinks.count();
  expect(linkCount).toBeGreaterThan(0);
  for (const sectionLink of await sectionLinks.all()) {
    const href = await sectionLink.getAttribute("href");
    expect(href).toMatch(/^#[a-z0-9-]+$/);
    await expect(page.locator(href!)).toHaveCount(1);
  }
}
