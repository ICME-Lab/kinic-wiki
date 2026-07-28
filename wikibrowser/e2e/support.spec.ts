import { expect, test } from "@playwright/test";

test("renders the support route with metadata, navigation, links, and sitemap entry", async ({ page, request }) => {
  await page.goto("/support");

  await expect(page).toHaveTitle("Support | Kinic Wiki");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "Get help with Kinic Wiki and the Kinic Wiki ChatGPT app."
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://wiki.kinic.xyz/support");
  await expect(page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible();

  const sectionLinks = page.locator('nav[aria-label="Support sections"]:visible a');
  const linkCount = await sectionLinks.count();
  expect(linkCount).toBeGreaterThan(0);
  for (let index = 0; index < linkCount; index += 1) {
    const href = await sectionLinks.nth(index).getAttribute("href");
    expect(href).toMatch(/^#[a-z0-9-]+$/);
    await expect(page.locator(href!)).toHaveCount(1);
  }

  await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy-policy");
  const externalContacts = page.getByRole("link", { name: "https://x.com/kinic_app" });
  expect(await externalContacts.count()).toBeGreaterThan(0);
  for (let index = 0; index < await externalContacts.count(); index += 1) {
    const externalContact = externalContacts.nth(index);
    await expect(externalContact).toHaveAttribute("href", "https://x.com/kinic_app");
    await expect(externalContact).toHaveAttribute("target", "_blank");
    await expect(externalContact).toHaveAttribute("rel", /(?:^|\s)noreferrer(?:\s|$)/);
    await expect(externalContact).toHaveAttribute("rel", /(?:^|\s)noopener(?:\s|$)/);
  }

  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.ok()).toBe(true);
  expect(await sitemap.text()).toContain("<loc>https://wiki.kinic.xyz/support</loc>");
});
