import { expect, test } from "@playwright/test";

test("create database dialog is modal and restores focus", async ({ page }) => {
  await page.goto("/");
  const dependencyVersion = await page.evaluate(async () => {
    const source = await (await fetch("/app/create-database-dialog.tsx")).text();
    return source.match(/react_jsx-dev-runtime\.js\?v=([a-f0-9]+)/)?.[1] ?? null;
  });
  expect(dependencyVersion).not.toBeNull();

  await page.evaluate(async (version) => {
    const React = (await import(/* @vite-ignore */ `/node_modules/.vite/deps/react.js?v=${version}`)).default;
    const { createRoot } = (await import(/* @vite-ignore */ `/node_modules/.vite/deps/react-dom_client.js?v=${version}`)).default;
    const componentPath = "/app/create-database-dialog.tsx";
    const { CreateDatabaseDialog } = await import(/* @vite-ignore */ componentPath);
    const host = document.createElement("div");
    host.id = "modal-test-harness";
    document.body.append(host);

    function Harness() {
      const [open, setOpen] = React.useState(false);
      const [creating, setCreating] = React.useState(false);
      const cancelCount = React.useRef(0);
      globalThis.__kinicModalTest = {
        cancelCount,
        setCreating
      };
      return React.createElement(
        React.Fragment,
        null,
        React.createElement("button", { id: "open-test-modal", onClick: () => setOpen(true) }, "Open test modal"),
        React.createElement(CreateDatabaseDialog, {
          createDisabled: creating,
          createLabel: "Create",
          creating,
          databaseName: "",
          open,
          paymentNote: "Test payment.",
          requiredBalanceLabel: "1 cycle",
          validationError: null,
          onCancel: () => {
            cancelCount.current += 1;
            setOpen(false);
          },
          onChange: () => {},
          onSubmit: () => {}
        })
      );
    }

    createRoot(host).render(React.createElement(Harness));
  }, dependencyVersion);

  const trigger = page.locator("#open-test-modal");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create database" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("dialog:modal")).toHaveCount(1);
  await expect(page.locator("#database-name-input")).toBeFocused();

  await page.evaluate(() => document.querySelector<HTMLElement>("#open-test-modal")?.focus());
  await expect(trigger).not.toBeFocused();
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(false);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await modalCancelCount(page)).toBe(1);

  await trigger.click();
  await page.evaluate(() => globalThis.__kinicModalTest?.setCreating(true));
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(await modalCancelCount(page)).toBe(1);
  await page.evaluate(() => globalThis.__kinicModalTest?.setCreating(false));
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await modalCancelCount(page)).toBe(2);
});

async function modalCancelCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => globalThis.__kinicModalTest?.cancelCount.current ?? -1);
}

declare global {
  var __kinicModalTest: {
    cancelCount: { current: number };
    setCreating: (value: boolean) => void;
  } | undefined;
}
