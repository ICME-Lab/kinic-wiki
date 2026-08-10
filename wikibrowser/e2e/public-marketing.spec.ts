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
  await followInternalLink(page, memoryFlow, "#memory-flow", /\/#memory-flow$/);
  await expect(page.getByRole("heading", { name: "Capture the context. Maintain the knowledge. Check the answer." })).toBeVisible();

  await expectExternalLink(page.getByRole("link", { name: "Get the iOS app" }), APP_STORE_URL);
  await expectExternalLink(page.getByRole("link", { name: "Install Clipper" }), CLIPPER_STORE_URL);
  await expect(page.getByRole("link", { name: "Install the CLI" })).toHaveAttribute("href", "/docs/cli");

  await followInternalLink(page, page.getByRole("link", { name: "iOS setup & troubleshooting" }), "/docs/ios", /\/docs\/ios$/);
  await expect(page.getByRole("heading", { level: 1, name: "Set up Save to KinicWiki." })).toBeVisible();

  await page.goto("/");
  await followInternalLink(page, page.getByRole("link", { name: "Read the Clipper guide" }), "/docs/clipper", /\/docs\/clipper$/);
  await expect(page.getByRole("heading", { level: 1, name: "Save browser context with Wiki Clipper" })).toBeVisible();

  await page.goto("/");
  await followInternalLink(page, primaryNavigation.getByRole("link", { name: "Open Dashboard" }), "/dashboard", /\/dashboard$/);
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

  await followInternalLink(page, page.getByRole("link", { name: "Read the Privacy Policy" }), "/privacy-policy", /\/privacy-policy$/);
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();

  await page.goto("/docs/ios");
  await expect(page).toHaveTitle("KinicWiki iOS Setup Guide | Kinic Wiki");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://wiki.kinic.xyz/docs/ios");
  await expect(page.getByRole("heading", { level: 1, name: "Set up Save to KinicWiki." })).toBeVisible();
  await expectExternalLink(page.getByRole("link", { name: "View on the App Store" }), APP_STORE_URL);
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
    "Use Capture history to inspect requests",
    "Ask AI history stays on this device",
    "Generation request data is discarded after processing"
  ]) {
    await expect(page.getByText(requirement, { exact: false }).first()).toBeVisible();
  }

  await followInternalLink(page, page.getByRole("link", { name: "See what the app does" }), "/ios", /\/ios$/);
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
  await followInternalLink(
    page,
    page.getByRole("region", { name: "Primary docs" }).getByRole("link", { name: /Wiki Clipper/ }),
    "/docs/clipper",
    /\/docs\/clipper$/
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs");
  const mobileNavigation = await openMobileAdminNavigation(page);
  await followInternalLink(page, mobileNavigation.getByRole("link", { name: "iOS App" }), "/docs/ios", /\/docs\/ios$/);
});

test("renders the skills overview and each workflow detail", async ({ page }) => {
  await page.goto("/docs/skills");

  await expect(page).toHaveTitle("Kinic Wiki Skills Docs");
  await expect(page.getByRole("heading", { level: 1, name: "Agent workflow skills" })).toBeVisible();
  const skillLinks = page.getByRole("region", { name: "Skill workflow docs" });
  await expect(skillLinks.getByRole("link")).toHaveCount(7);

  for (const skill of [
    { slug: "query", title: "Query", skillName: "kinic-wiki-query" },
    { slug: "edit", title: "Edit", skillName: "kinic-wiki-edit" },
    { slug: "mcp", title: "MCP", skillName: "kinic-wiki-mcp" },
    { slug: "ingest", title: "Ingest", skillName: "kinic-wiki-ingest" },
    { slug: "lint", title: "Lint", skillName: "kinic-wiki-lint" },
    { slug: "context-pack", title: "Context Pack", skillName: "kinic-context-pack" },
    { slug: "registry", title: "Skill Registry", skillName: "kinic-skill-registry" }
  ]) {
    await followInternalLink(
      page,
      page.getByRole("region", { name: "Skill workflow docs" }).getByRole("link", { name: new RegExp(skill.title) }),
      `/docs/skills/${skill.slug}`,
      new RegExp(`/docs/skills/${skill.slug}$`)
    );
    await expect(page).toHaveTitle(`Kinic Wiki ${skill.title} Skill`);
    await expect(page.getByRole("heading", { level: 1, name: skill.title })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "SKILL.md" })).toBeVisible();
    const renderedSkill = page.getByRole("region", { name: "Rendered SKILL.md" });
    await expect(renderedSkill.getByText(skill.skillName, { exact: true })).toBeVisible();
    if (skill.slug === "query") {
      await expect(page.getByRole("button", { name: "Rendered" })).toHaveAttribute("aria-pressed", "true");
      await expect(renderedSkill.getByRole("heading", { level: 3, name: "Kinic Wiki Query" })).toBeVisible();
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.getByRole("button", { name: "Copy SKILL.md" }).click();
      await expect(page.getByRole("button", { name: "SKILL.md copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`name: ${skill.skillName}`);
      await page.getByRole("button", { name: "Raw" }).click();
      await expect(page.getByRole("region", { name: "Raw SKILL.md" }).locator("pre")).toContainText(`name: ${skill.skillName}`);
      for (const section of ["Common commands", "Safety", "Responsibilities"]) {
        await expect(page.getByRole("heading", { name: section })).toBeVisible();
      }
    }
    await followInternalLink(page, page.locator("#admin-main").getByRole("link", { name: "Skills", exact: true }), "/docs/skills", /\/docs\/skills$/);
  }
});

for (const viewport of MOBILE_VIEWPORTS) {
  test(`keeps public calls to action visible at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const cases = [
      { path: "/", action: (target: Page) => target.getByRole("link", { name: "Install Clipper" }) },
      { path: "/ios", action: (target: Page) => target.getByRole("link", { name: "Download on the App Store" }) },
      { path: "/docs/ios", action: (target: Page) => target.getByRole("link", { name: "View on the App Store" }) },
      { path: "/docs/clipper", action: (target: Page) => target.getByRole("link", { name: "Add to Chrome" }) },
      { path: "/docs/skills/query", action: (target: Page) => target.getByRole("button", { name: "Copy SKILL.md" }) }
    ];

    for (const entry of cases) {
      await page.goto(entry.path);
      const callToAction = entry.action(page).first();
      await expectActionableWithinViewport(page, callToAction);
      if (entry.path === "/docs/skills/query") {
        await page.getByRole("button", { name: "Raw" }).click();
        const rawMarkdown = page.getByRole("region", { name: "Raw SKILL.md" }).locator("pre");
        expect(await rawMarkdown.evaluate((element) => element.scrollHeight === element.clientHeight)).toBe(true);
      }
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

async function followInternalLink(page: Page, link: Locator, href: string, expectedUrl: RegExp) {
  await expect(link).toHaveAttribute("href", href);
  await expectHydrated(page);
  await link.click();
  await expect(page).toHaveURL(expectedUrl);
}

async function openMobileAdminNavigation(page: Page): Promise<Locator> {
  const navigation = page.getByRole("navigation", { name: "Admin navigation" });
  const trigger = page.getByRole("button", { name: "Open admin navigation" });

  await expectHydrated(page);
  await trigger.click();
  await expect(navigation).toBeVisible();

  return navigation;
}

async function expectHydrated(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
}

async function expectActionableWithinViewport(page: Page, action: Locator) {
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeVisible();
  await action.click({ trial: true });
  const box = await action.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}
