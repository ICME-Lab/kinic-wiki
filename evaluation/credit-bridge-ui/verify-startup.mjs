// Real Chromium windows/components; deliberately deferred synthetic actor transport.
import assert from "node:assert/strict";
import {
  chromium,
  expect,
} from "../../wikibrowser/node_modules/@playwright/test/index.mjs";
const browser = await chromium.launch({ headless: true });
const api = async (method, args = []) =>
  (
    await fetch("http://127.0.0.1:3036/fixture-api", {
      method: "POST",
      body: JSON.stringify({ method, args }),
    })
  ).json();
try {
  await api("reset");
  const context = await browser.newContext();
  const errors = [];
  context.on("page", (page) =>
    page.on("pageerror", (error) => errors.push(error.message)),
  );
  const vault = await context.newPage();
  await vault.goto("http://localhost:3036/");
  let opened = vault.waitForEvent("popup");
  await vault
    .getByRole("button", { name: "Link Wiki account", exact: true })
    .click();
  const link = await opened;
  await link.getByRole("button", { name: "Approve account link" }).click();
  await vault.getByRole("button", { name: "Close Wiki window" }).click();
  opened = vault.waitForEvent("popup");
  await vault.getByRole("button", { name: "Charge from Wiki credits" }).click();
  const wiki = await opened;
  for (const name of [
    "Get transfer estimate",
    "Confirm and hold credits",
    "Request Vault readiness",
    "Send held credits",
  ])
    await wiki.getByRole("button", { name }).click();
  await wiki.getByText("Paid", { exact: true }).waitFor();
  const originalURL = new URL(wiki.url());
  const originalId = new URLSearchParams(originalURL.hash.slice(1)).get("id");
  await api("quote_vault_transfer", [
    "fixture-owner-db",
    { Exact: { $bigint: "900000000" } },
    Array(16).fill(2),
  ]);
  for (const kind of ["marked", "retired marked", "unmarked"]) {
    for (const delayed of ["get_vault_link", "get_vault_transfer"]) {
      let release, intercepted;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      const entered = new Promise((resolve) => {
        intercepted = resolve;
      });
      let pendingRequests = 0;
      const routeHandler = async (route) => {
        const { method } = route.request().postDataJSON();
        if (method === "get_pending_vault_transfer") pendingRequests++;
        if (method === delayed) {
          intercepted();
          await blocked;
        }
        if (kind === "retired marked" && method === "get_vault_transfer")
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ Err: { NotFound: null } }),
          });
        else await route.continue();
      };
      await wiki.route("**/fixture-api", routeHandler);
      try {
        const next = new URL(originalURL);
        if (kind === "unmarked") {
          const fragment = new URLSearchParams(next.hash.slice(1));
          fragment.delete("receipt");
          next.hash = fragment.toString();
        }
        await wiki.evaluate(
          (url) => history.replaceState(null, "", url),
          next.href,
        );
        await wiki.reload({ waitUntil: "domcontentloaded" });
        await entered;
        await wiki
          .getByText("Connected to your Vault window.", { exact: true })
          .waitFor();
        const recover = wiki.getByRole("button", {
          name: "Recover pending transfer",
        });
        await expect(recover).toBeDisabled();
        // Programmatic DOM click also respects the native disabled control.
        await recover.evaluate((button) => button.click());
        assert.equal(pendingRequests, 0);
        assert.equal(wiki.url(), next.href);
        for (const name of [
          "Confirm and hold credits",
          "Request Vault readiness",
          "Send held credits",
        ])
          assert.equal(await wiki.getByRole("button", { name }).count(), 0);
        release();
        await expect(recover).toBeEnabled();
        if (kind !== "retired marked")
          await wiki.getByText("Paid", { exact: true }).waitFor();
        await recover.click();
        await wiki.getByText(/Another transfer is pending/).waitFor();
        assert.equal(
          new URLSearchParams(new URL(wiki.url()).hash.slice(1)).get("id"),
          originalId,
        );
        for (const name of [
          "Confirm and hold credits",
          "Request Vault readiness",
          "Send held credits",
        ])
          assert.equal(await wiki.getByRole("button", { name }).count(), 0);
        assert.deepEqual((await api("state")).count, {
          quote: 2,
          hold: 1,
          send: 1,
          prepare: 1,
        });
        console.log(
          `${kind} A / delayed ${delayed}: recovery blocked until initialization; A preserved PASS`,
        );
      } finally {
        release();
        await wiki.unrouteAll({ behavior: "wait" });
      }
    }
  }
  // Pending B remains usable through a fresh Vault-owned channel after all old-A races.
  const freshVault = await context.newPage();
  await freshVault.goto("http://localhost:3036/");
  opened = freshVault.waitForEvent("popup");
  await freshVault
    .getByRole("button", { name: "Charge from Wiki credits" })
    .click();
  const freshWiki = await opened;
  await freshWiki.getByText("Quoted", { exact: true }).waitFor();
  for (const name of [
    "Confirm and hold credits",
    "Request Vault readiness",
    "Send held credits",
  ])
    await freshWiki.getByRole("button", { name }).click();
  await freshWiki.getByText("Paid", { exact: true }).waitFor();
  assert.equal(wiki.isClosed(), false);
  assert.deepEqual((await api("state")).count, {
    quote: 2,
    hold: 2,
    send: 2,
    prepare: 2,
  });
  assert.deepEqual(errors, []);
  console.log(
    "fresh Vault window recovers and completes B while original A window survives PASS",
  );
  await context.close();
} finally {
  await browser.close();
}
