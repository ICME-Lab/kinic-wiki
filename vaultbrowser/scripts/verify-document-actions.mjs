// Synthetic documents only. Never targets a real Vault or real funds.
import assert from "node:assert/strict";
import { chromium, expect } from "../../wikibrowser/node_modules/@playwright/test/index.mjs";

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${process.env.VAULT_FIXTURE_URL ?? "http://127.0.0.1:3026"}/?state=opened`);
    await page.getByLabel("Document title").waitFor();
    assert.equal(await page.evaluate(() => !!window.syntheticNetwork), true, "Synthetic fixture required");
    const name = await page.locator(".vault-document-text > span").first().innerText();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByLabel("Document title")).toHaveValue(name);
    await expect(page.getByRole("button", { name: "Delete document", exact: true })).toHaveCount(0);
    await expect(page.getByText("Document settings", { exact: true })).toHaveCount(0);
    const trigger = page.getByRole("button", { name: `Actions for ${name}`, exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    const open = async permanent => {
      await trigger.click();
      const action = permanent ? "Permanently delete document and history" : "Delete document";
      await page.getByRole("menuitem", { name: action, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: action, exact: true });
      await expect(dialog).toBeVisible();
      const bounds = await dialog.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 900, "Confirmation must fit the viewport");
      assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false, "Confirmation must not overflow horizontally");
      return { dialog, submit: dialog.getByRole("button", { name: action, exact: true }), input: dialog.getByLabel("Type delete to confirm") };
    };
    let confirmation = await open(false);
    await expect(confirmation.submit).toBeDisabled();
    await confirmation.input.fill("DELETE");
    await expect(confirmation.submit).toBeDisabled();
    await confirmation.input.fill("delete");
    await expect(confirmation.submit).toBeEnabled();
    await confirmation.dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(trigger).toBeFocused();
    confirmation = await open(true);
    await expect(confirmation.input).toHaveValue("");
    await expect(confirmation.submit).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    confirmation = await open(false);
    await confirmation.input.fill("delete");
    await confirmation.submit.click();
    await page.getByRole("button", { name: `${name} (deleted)`, exact: true }).click();
    await page.getByRole("button", { name: "Show version history", exact: true }).click();
    await expect(page.getByRole("button", { name: "View revision 1", exact: true })).toBeVisible();
    confirmation = await open(true);
    await confirmation.input.fill("delete");
    await confirmation.submit.click();
    await expect(page.getByText("No documents yet. Create a note, credential or attachment.", { exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: card menu, keyboard/focus, exact delete confirmation, cancellation, retained history, permanent deletion`);
    await page.close();
  }
} finally {
  await browser.close();
}
