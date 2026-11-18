import { expect, test } from "@playwright/test";

const wikiOrigin = "http://127.0.0.1:3016";
const vaultOrigin = "http://vault.localhost:3016";
const embed = `${vaultOrigin}/embed/0123456789abcdef0123456789abcdef/fedcba9876543210fedcba9876543210`;
const reference = `[非公開資料](${embed})`;

test("mobile preview waits for an explicit open and keeps code fences inert", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const vaultRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin === vaultOrigin) vaultRequests.push(request.url());
  });
  await page.goto("/");
  const open = page.getByRole("button", { name: "Open private document" });
  await expect(open).toHaveCount(1);
  await expect(page.locator("pre code")).toContainText(reference);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(vaultRequests).toEqual([]);

  await open.focus();
  await page.keyboard.press("Enter");
  const frame = page.locator("iframe");
  await expect(frame).toHaveAttribute("src", embed);
  await expect(frame.contentFrame().getByText("Synthetic document inside Vault.")).toBeVisible();
  expect(vaultRequests).toEqual([embed]);
  expect(await frame.evaluate((element) => (element as HTMLIFrameElement).contentDocument)).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await expect(page.getByRole("button", { name: "Close private document" })).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(frame).toHaveCount(0);
  await expect(open).toBeFocused();
  expect(vaultRequests).toEqual([embed]);
});

test("only the connected picker can append to the live Wiki draft", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.addEventListener("message", (event) => {
      if (event.data?.type === "kinic-vault-selection") {
        document.body.dataset.selectionOrigin = event.origin;
      }
    });
  });
  const insert = page.getByRole("button", { name: "Insert private document" });
  const [picker] = await Promise.all([page.waitForEvent("popup"), insert.press("Enter")]);
  await expect(picker.getByRole("status")).toHaveText("Connected to Wiki");

  const [unowned] = await Promise.all([
    page.waitForEvent("popup"),
    page.evaluate((origin) => { window.open(`${origin}/spoof`, "_blank"); }, vaultOrigin)
  ]);
  await expect(page.locator("body")).toHaveAttribute("data-selection-origin", vaultOrigin);
  await unowned.close();
  const draft = page.getByRole("textbox");
  await expect(draft).toHaveText("Original draft.");

  // Renderer-initiated navigation preserves the owning window relationship.
  await picker.evaluate((url) => location.replace(url), `${wikiOrigin}/spoof`);
  await expect(page.locator("body")).toHaveAttribute("data-selection-origin", wikiOrigin);
  await expect(draft).toHaveText("Original draft.");

  const [retry] = await Promise.all([page.waitForEvent("popup"), picker.waitForEvent("close"), insert.click()]);
  const select = retry.getByRole("button", { name: "Select fixture document" });
  await expect(select).toBeEnabled();

  await draft.press("End");
  await page.keyboard.insertText(" Edited while the picker was open.");
  await expect(draft).toHaveText("Original draft. Edited while the picker was open.");
  await Promise.all([retry.waitForEvent("close"), select.click()]);

  await expect(draft.locator(".cm-line").nth(2)).toHaveText(reference);
  await expect(draft.locator(".cm-line").first()).toHaveText("Original draft. Edited while the picker was open.");
  await expect(draft.getByText("非公開資料", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
});
