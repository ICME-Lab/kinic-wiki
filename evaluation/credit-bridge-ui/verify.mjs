// Real components, real cross-origin windows and COOP; synthetic actor responses only.
import assert from "node:assert/strict";
import { chromium } from "../../wikibrowser/node_modules/@playwright/test/index.mjs";
import { mkdir } from "node:fs/promises";
const output = new URL(
  "../../.superpowers/sdd/2026-11-16-vault-fast-save-wiki-credit/browser/",
  import.meta.url,
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const api = async (method, args = []) =>
  JSON.parse(
    await (
      await fetch("http://127.0.0.1:3036/fixture-api", {
        method: "POST",
        body: JSON.stringify({ method, args }),
      })
    ).text(),
  );
try {
  for (const [label, width, height, all] of [
    ["desktop", 1280, 900, false],
    ["mobile", 390, 844, true],
  ]) {
    await api("reset");
    const context = await browser.newContext({ viewport: { width, height } });
    const errors = [];
    context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
    const page = await context.newPage();
    await page.goto("http://localhost:3036/");
    const first = page.waitForEvent("popup");
    await page
      .getByRole("button", { name: "Link Wiki account", exact: true })
      .click();
    const linking = await first;
    await linking.getByRole("button", { name: "Approve account link" }).click();
    await linking.getByText(/This window only links accounts/).waitFor();
    assert.equal(
      await linking
        .getByRole("button", { name: "Get transfer estimate" })
        .count(),
      0,
    );
    assert.equal((await api("state")).count.hold, 0);
    await page
      .getByRole("button", { name: "Charge from Wiki credits" })
      .waitFor();
    await page.getByRole("button", { name: "Close Wiki window" }).click();
    const second = page.waitForEvent("popup");
    await page
      .getByRole("button", { name: "Charge from Wiki credits" })
      .focus();
    await page.keyboard.press("Enter");
    const wiki = await second;
    await wiki
      .getByText("Connected to your Vault window.", { exact: true })
      .waitFor();
    assert.equal(await wiki.evaluate(() => !!window.opener), true);
    await wiki
      .getByRole("combobox", { name: "Owner database", exact: true })
      .focus();
    assert.equal(
      await wiki
        .getByRole("combobox", { name: "Owner database", exact: true })
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await wiki
      .getByRole("button", { name: "Recover pending transfer" })
      .focus();
    await wiki.keyboard.press("Enter");
    await wiki
      .getByText("No pending transfer for this account or selected database.", {
        exact: true,
      })
      .waitFor();
    if (all)
      await wiki.getByLabel("All available credits", { exact: true }).check();
    else
      await wiki.getByLabel("Exact cycles", { exact: true }).fill("123456789");
    await wiki.getByRole("button", { name: "Get transfer estimate" }).click();
    await wiki.getByText("Quoted", { exact: true }).waitFor();
    assert.equal((await api("state")).count.hold, 0);
    if (all) {
      assert.equal(
        await wiki
          .getByRole("button", { name: "Confirm and hold credits" })
          .isDisabled(),
        true,
      );
      await wiki.getByRole("checkbox").focus();
      await wiki.keyboard.press("Space");
      assert.equal(await wiki.getByRole("checkbox").isChecked(), true);
    }
    await wiki.screenshot({
      path: new URL(`${label}-quote.png`, output).pathname,
      fullPage: true,
    });
    await wiki
      .getByRole("button", { name: "Confirm and hold credits" })
      .focus();
    await wiki.keyboard.press("Enter");
    await wiki.getByText("Offered", { exact: true }).waitFor();
    assert.equal((await api("state")).count.send, 0);
    if (label === "desktop") {
      const attackOpened = page.waitForEvent("popup");
      await page.evaluate(() =>
        window.open("http://127.0.0.1:3036/attacker", "_blank"),
      );
      const attacker = await attackOpened;
      await attacker.waitForLoadState();
      const nonce = new URLSearchParams(new URL(wiki.url()).hash.slice(1)).get(
        "nonce",
      );
      const operation = (await api("state")).transfer.offer.operation
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      await attacker.evaluate(
        ({ nonce, operation }) =>
          window.opener.postMessage(
            {
              protocol: "kinic-credit-v1",
              type: "offer",
              id: operation,
              nonce,
            },
            "http://localhost:3036",
          ),
        { nonce, operation },
      );
      await page.waitForTimeout(150);
      assert.equal(
        (await api("state")).count.prepare,
        0,
        "same-origin different window must not prepare",
      );
      await attacker.close();
    }
    await wiki.getByRole("button", { name: "Request Vault readiness" }).focus();
    await wiki.keyboard.press("Enter");
    await wiki.getByRole("button", { name: "Send held credits" }).waitFor();
    assert.equal((await api("state")).count.send, 0);
    await wiki.getByRole("button", { name: "Send held credits" }).focus();
    await wiki.keyboard.press("Enter");
    await wiki.getByText("Paid", { exact: true }).waitFor();
    const state = await api("state");
    assert.deepEqual(state.count, { quote: 1, hold: 1, send: 1, prepare: 1 });
    assert.equal(
      state.transfer.offer.amount_cycles.$bigint,
      all ? "9800000000" : "123456789",
    );
    const overflow = await wiki.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert.equal(overflow, false);
    await wiki.screenshot({
      path: new URL(`${label}-paid.png`, output).pathname,
      fullPage: true,
    });
    await page.screenshot({
      path: new URL(`${label}-vault.png`, output).pathname,
      fullPage: true,
    });
    assert.equal(
      await wiki.getByRole("button", { name: "Start another charge" }).count(),
      0,
    );
    await wiki
      .getByRole("button", { name: "Recover pending transfer" })
      .click();
    await wiki.getByText(/For another charge, return/).waitFor();
    assert.equal(
      await wiki.getByRole("button", { name: "Get transfer estimate" }).count(),
      0,
    );
    let previous = wiki;
    for (const cancel of [true, false]) {
      const nextPopup = page.waitForEvent("popup");
      await page
        .getByRole("button", { name: "Charge from Wiki credits" })
        .click();
      const next = await nextPopup;
      await next
        .getByText("Connected to your Vault window.", { exact: true })
        .waitFor();
      assert.equal(previous.isClosed(), true);
      assert.notEqual(
        new URLSearchParams(new URL(next.url()).hash.slice(1)).get("nonce"),
        new URLSearchParams(new URL(previous.url()).hash.slice(1)).get("nonce"),
      );
      await next.getByLabel("Exact cycles", { exact: true }).fill("250000000");
      await next.getByRole("button", { name: "Get transfer estimate" }).click();
      await next
        .getByRole("button", { name: "Confirm and hold credits" })
        .focus();
      await next.keyboard.press("Enter");
      await next.getByText("Offered", { exact: true }).waitFor();
      if (cancel) {
        await next
          .getByRole("button", { name: "Cancel unsent transfer" })
          .click();
        await next.getByText("Refunded", { exact: true }).waitFor();
        assert.equal(
          await next
            .getByRole("button", { name: "Start another charge" })
            .count(),
          0,
        );
      } else {
        await next
          .getByRole("button", { name: "Request Vault readiness" })
          .click();
        await next.getByRole("button", { name: "Send held credits" }).click();
        await next.getByText("Paid", { exact: true }).waitFor();
      }
      previous = next;
    }
    assert.deepEqual((await api("state")).count, {
      quote: 3,
      hold: 3,
      send: 2,
      prepare: 2,
    });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `${label}: real two-origin link + ${all ? "AllAvailable" : "Exact"} hold/ready/manual send + paid-new/cancel-new fresh channels PASS`,
    );
  }
  // Keep the original Vault/Wiki pair alive while another pair creates a new operation.
  await api("reset");
  const tabs = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const tabErrors = [];
  tabs.on("page", (p) => p.on("pageerror", (e) => tabErrors.push(e.message)));
  const vaultA = await tabs.newPage();
  await vaultA.goto("http://localhost:3036/");
  let nextWindow = vaultA.waitForEvent("popup");
  await vaultA
    .getByRole("button", { name: "Link Wiki account", exact: true })
    .click();
  const linkWindow = await nextWindow;
  await linkWindow
    .getByRole("button", { name: "Approve account link" })
    .click();
  await vaultA.getByRole("button", { name: "Close Wiki window" }).click();
  nextWindow = vaultA.waitForEvent("popup");
  await vaultA
    .getByRole("button", { name: "Charge from Wiki credits" })
    .click();
  const receiptA = await nextWindow;
  await receiptA.getByRole("button", { name: "Get transfer estimate" }).click();
  await receiptA
    .getByRole("button", { name: "Confirm and hold credits" })
    .click();
  await receiptA
    .getByRole("button", { name: "Request Vault readiness" })
    .click();
  await receiptA.getByRole("button", { name: "Send held credits" }).click();
  await receiptA.getByText("Paid", { exact: true }).waitFor();
  const savedA = receiptA.url();
  const vaultB = await tabs.newPage();
  await vaultB.goto("http://localhost:3036/");
  nextWindow = vaultB.waitForEvent("popup");
  await vaultB
    .getByRole("button", { name: "Charge from Wiki credits" })
    .click();
  const pendingB = await nextWindow;
  await pendingB.getByRole("button", { name: "Get transfer estimate" }).click();
  await pendingB.getByText("Quoted", { exact: true }).waitFor();
  assert.notEqual(new URL(pendingB.url()).hash, new URL(savedA).hash);
  for (const phase of ["Quoted", "Offered"]) {
    await pendingB.getByText(phase, { exact: true }).waitFor();
    await receiptA
      .getByRole("button", { name: "Recover pending transfer" })
      .click();
    await receiptA.getByText(/Another transfer is pending/).waitFor();
    await receiptA.getByText("Paid", { exact: true }).waitFor();
    assert.equal(receiptA.url(), savedA);
    assert.equal(
      await receiptA
        .getByRole("button", { name: "Confirm and hold credits" })
        .count(),
      0,
    );
    assert.equal(
      await receiptA
        .getByRole("button", { name: "Request Vault readiness" })
        .count(),
      0,
    );
    assert.equal(
      await receiptA.getByRole("button", { name: "Send held credits" }).count(),
      0,
    );
    await receiptA.reload();
    await receiptA.getByText("Paid", { exact: true }).waitFor();
    assert.equal(receiptA.url(), savedA);
    if (phase === "Quoted") {
      assert.deepEqual((await api("state")).count, {
        quote: 2,
        hold: 1,
        send: 1,
        prepare: 1,
      });
      await pendingB
        .getByRole("button", { name: "Confirm and hold credits" })
        .click();
    }
  }
  assert.equal(receiptA.isClosed(), false);
  assert.deepEqual((await api("state")).count, {
    quote: 2,
    hold: 2,
    send: 1,
    prepare: 1,
  });
  await pendingB
    .getByRole("button", { name: "Request Vault readiness" })
    .click();
  await pendingB.getByRole("button", { name: "Send held credits" }).click();
  await pendingB.getByText("Paid", { exact: true }).waitFor();
  assert.deepEqual((await api("state")).count, {
    quote: 2,
    hold: 2,
    send: 2,
    prepare: 2,
  });
  assert.equal(receiptA.url(), savedA);
  assert.equal(receiptA.isClosed(), false);
  assert.deepEqual(tabErrors, []);
  await tabs.close();
  console.log(
    "separate Vault tabs: terminal A recover/reload preserves A during Quoted/Offered B; fresh B window completes PASS",
  );
  // Unknown is recovered after reload and never offers a cancel/resend.
  await api("reset", [true]);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto("http://localhost:3036/");
  let opened = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "Link Wiki account", exact: true })
    .click();
  let wiki = await opened;
  await wiki.getByRole("button", { name: "Approve account link" }).click();
  await page.getByRole("button", { name: "Close Wiki window" }).click();
  opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Charge from Wiki credits" }).click();
  wiki = await opened;
  await wiki.getByRole("button", { name: "Get transfer estimate" }).click();
  await wiki.getByRole("button", { name: "Confirm and hold credits" }).click();
  await wiki.getByRole("button", { name: "Request Vault readiness" }).click();
  await wiki.getByRole("button", { name: "Send held credits" }).click();
  await wiki.getByText("Unknown", { exact: true }).waitFor();
  await wiki.reload();
  await wiki.getByText("Unknown", { exact: true }).waitFor();
  assert.equal(
    await wiki.getByRole("button", { name: "Cancel unsent transfer" }).count(),
    0,
  );
  assert.equal(
    await wiki.getByRole("button", { name: "Send held credits" }).count(),
    0,
  );
  await wiki.getByRole("button", { name: "Reconcile transfer" }).click();
  await wiki.getByText("Paid", { exact: true }).waitFor();
  assert.equal((await api("state")).count.send, 1);
  // Standalone Wiki hands off in the same tab. Vault does not preserve a Wiki opener.
  const standalone = await context.newPage();
  await standalone.goto("http://127.0.0.1:3036/vault-credit");
  await standalone.getByRole("link", { name: "Continue in Vault" }).click();
  await standalone.waitForURL("http://localhost:3036/**");
  assert.equal(await standalone.evaluate(() => window.opener), null);
  await context.close();
  console.log(
    "mobile Unknown/reload/reconcile + standalone top-level handoff PASS",
  );
} finally {
  await browser.close();
}
