// Actual certified UI + real II + actual canisters/crypto. Local fixture only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chromium, expect } from "../../wikibrowser/node_modules/@playwright/test/index.mjs";
import { idlFactory } from "../../packages/vault-candid/index.js";
import { assertDeviceKeyStore, readDeviceKeyStore } from "./device-key-store.mjs";
const require = createRequire(import.meta.url);
const { Cbor } = require("@icp-sdk/core/agent");
const { IDL } = require("@icp-sdk/core/candid");
const { Ed25519KeyIdentity } = require("@icp-sdk/core/identity");
const methods = new Map(idlFactory({ IDL })._fields);
const vaultURL = process.env.VAULT_ACCEPTANCE_URL;
const wikiURL = process.env.WIKI_ACCEPTANCE_URL;
const iiURL = process.env.II_ACCEPTANCE_URL;
for (const url of [vaultURL, wikiURL, iiURL]) {
  assert.ok(url, "Owned launcher URLs required");
  const h = new URL(url).hostname;
  assert.ok(["localhost", "127.0.0.1"].includes(h) || h.endsWith(".localhost"));
}
const canister = new URL(vaultURL).hostname.split(".")[0];
const out = new URL("../../target/vault-ii-acceptance/browser/", import.meta.url)
  .pathname;
mkdirSync(out, { recursive: true });
const results = [];
const pass = (name, details = {}) => {
  results.push({ name, ...details });
  console.log("PASS", name, JSON.stringify(details));
};
const browser = await chromium.launch({
  headless: true,
  args: [
    "--host-resolver-rules=MAP *.localhost 127.0.0.1",
    `--unsafely-treat-insecure-origin-as-secure=${[vaultURL, wikiURL, iiURL].join(",")}`,
  ],
});
const contexts = [];
const context = await browser.newContext({ acceptDownloads: true });
contexts.push(context);
context.setDefaultTimeout(60000);
let ownerCredentials = [];
async function completeLogin(popup, credentials, create = false) {
  await popup.waitForURL(iiURL + "/**");
  const cdp = await popup.context().newCDPSession(popup);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  for (const credential of credentials)
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
  const choose = popup.getByRole("button", {
    name: "Continue with passkey",
    exact: true,
  });
  const proceed = popup.getByRole("button", { name: "Continue", exact: true });
  await choose.or(proceed).first().waitFor();
  if (await choose.isVisible()) await choose.click();
  if (create) {
    await popup
      .getByRole("button", { name: "Create new identity", exact: true })
      .click();
    await popup.getByRole("textbox").fill("Disposable Vault acceptance");
    await popup
      .getByRole("button", { name: "Create identity", exact: true })
      .click();
  } else if (
    await popup
      .getByRole("button", { name: "Use existing identity", exact: true })
      .isVisible()
  ) {
    await popup
      .getByRole("button", { name: "Use existing identity", exact: true })
      .click();
  }
  await proceed.waitFor();
  const actual = (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  ).credentials;
  assert.ok(
    actual.length,
    "Actual II WebAuthn credentials required; dummy auth disabled",
  );
  const closed = popup.waitForEvent("close");
  await proceed.click();
  await closed;
  return actual;
}
async function signIn(
  page,
  button,
  credentials = ownerCredentials,
  create = false,
) {
  const popup = page.waitForEvent("popup");
  await button.click();
  return completeLogin(await popup, credentials, create);
}
async function inspector(page) {
  await page.route(
    new URL("/__acceptance-readback.mjs", page.url()).href,
    (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: readFileSync(
          new URL(
            "../../target/vault-browser-readback/readback.mjs",
            import.meta.url,
          ),
        ),
      }),
  );
}
const inspect = (page, method, ...args) =>
  page.evaluate(
    async ({ method, args }) => {
      const module = await import("/__acceptance-readback.mjs");
      return module[method](...args);
    },
    { method, args },
  );
const readback = (page) => inspect(page, "readback", canister, vaultURL);
const loginButton = (page) =>
  page.getByRole("button", {
    name: "Sign in with Internet Identity",
    exact: true,
  });
const editor = (page) => page.locator('.cm-content[contenteditable="true"]');
async function settle(page, errors = false) {
  await page
    .getByText("Processing Vault operation…", { exact: true })
    .waitFor({ state: "hidden", timeout: 120000 });
  if (!errors)
    assert.deepEqual(await page.getByRole("alert").allTextContents(), []);
}
async function action(page, name, errors = false) {
  const button = page.getByRole("button", {
    name,
    exact: true,
  });
  for (const details of await button.locator("xpath=ancestor::details").all()) {
    if (!(await details.evaluate((e) => e.open)))
      await details.locator(":scope > summary").click();
  }
  await button.click();
  await settle(page, errors);
}
async function retain(page) {
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    window.retainedEditor = content?.cmTile.root.view;
    window.retainedFields = [
      ...document.querySelectorAll(
        '[data-vault-sensitive] input, [data-vault-sensitive] textarea, input[type="file"]',
      ),
    ];
  });
}
async function assertCleared(page) {
  assert.equal(await editor(page).count(), 0);
  assert.deepEqual(
    await page.evaluate(() => ({
      text: window.retainedEditor?.state.doc.toString() ?? "",
      dom: window.retainedEditor?.contentDOM.textContent ?? "",
      fields: (window.retainedFields ?? []).every(
        (e) => !e.value && (!e.files || e.files.length === 0),
      ),
    })),
    { text: "", dom: "", fields: true },
  );
}
try {
  const vault = await context.newPage();
  vault.on("dialog", (d) => d.accept());
  await vault.addInitScript(() => {
    window.vaultCredentialCalls = 0;
    for (const method of ["create", "get"]) {
      const original = navigator.credentials[method].bind(
        navigator.credentials,
      );
      navigator.credentials[method] = (...args) => {
        window.vaultCredentialCalls++;
        return original(...args);
      };
    }
    window.blobEvents = [];
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.blobEvents.push(["create", url]);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.blobEvents.push(["revoke", url]);
      return revoke(url);
    };
  });
  let dropMethod, dropAction, delayMethod, releaseResponse;
  const retryTraces = new Set();
  const startRetryTrace = (method, action) => {
    const trace = { method, action, phase: "initial-attempt", requests: [] };
    retryTraces.add(trace);
    return trace;
  };
  const finishRetryTrace = (trace) => {
    retryTraces.delete(trace);
    const dropped = trace.requests.filter((r) => r.outcome === "dropped");
    const successfulRetry = trace.requests.filter(
      (r) =>
        r.phase === "post-click-application-retry" &&
        r.outcome === "successful",
    );
    assert.ok(
      dropped.length > 0,
      `${trace.method}: original dropped request required`,
    );
    assert.ok(
      successfulRetry.length > 0,
      `${trace.method}: successful post-click request required`,
    );
    for (const request of trace.requests) {
      assert.equal(
        request.sha256,
        dropped[0].sha256,
        `${trace.method}: complete Candid arguments must survive application retry`,
      );
      assert.ok(["dropped", "successful"].includes(request.outcome));
      assert.ok(
        request.status >= 200 && request.status < 300,
        "Real ingress must receive a successful HTTP response before drop/delivery",
      );
    }
    return {
      method: trace.method,
      action: trace.action,
      requests: trace.requests,
    };
  };
  let delayedReady;
  let chunkReads = 0;
  // Execute real ingress, then drop or hold the actual HTTP reply. No fabricated reply.
  await vault.route("**/api/v*/canister/**/call", async (route) => {
    const body = route.request().postDataBuffer();
    const content = body ? Cbor.decode(body).content : undefined;
    const method = content?.method_name;
    if (method === "get_chunk") chunkReads++;
    let actionName;
    if (method === "mutate")
      actionName = Object.keys(
        IDL.decode(methods.get(method).argTypes, new Uint8Array(content.arg))[0]
          .action,
      )[0];
    // Capture the complete Candid payload before deciding how to deliver its reply.
    // The per-case collector closes before independent derivations or later uploads.
    const observations = [...retryTraces]
      .filter(
        (trace) =>
          trace.method === method &&
          (!trace.action || trace.action === actionName),
      )
      .map((trace) => {
        const request = {
          phase: trace.phase,
          sha256: createHash("sha256").update(content.arg).digest("hex"),
          outcome: "pending",
        };
        trace.requests.push(request);
        return request;
      });
    if (method === dropMethod && (!dropAction || actionName === dropAction)) {
      const response = await route.fetch();
      for (const request of observations) {
        request.status = response.status();
        request.outcome = "dropped";
      }
      await route.abort("failed");
    } else if (method === delayMethod) {
      delayMethod = undefined;
      const response = await route.fetch();
      delayedReady();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              Error("Held actual response was not released within 30 seconds"),
            ),
          30000,
        );
        releaseResponse = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      await route.fulfill({ response });
    } else if (observations.length) {
      const response = await route.fetch();
      await route.fulfill({ response });
      for (const request of observations) {
        request.status = response.status();
        request.outcome = response.ok() ? "successful" : "failed";
      }
    } else await route.continue();
  });
  await vault.goto(vaultURL);
  await inspector(vault);
  ownerCredentials = await signIn(vault, loginButton(vault), [], true);
  await vault
    .getByRole("button", { name: "Create Vault", exact: true })
    .waitFor();
  const owner = (await readback(vault)).principal;
  const disclosure = vault.getByText(
    /This release has no backup or independent recovery/,
  );
  assert.equal(await disclosure.count(), 0);
  await vault.getByRole("button", { name: "Account settings", exact: true }).click();
  assert.equal(
    await vault
      .locator("summary").filter({ hasText: "Account & storage" })
      .evaluate((e) => e.closest("details").open),
    false,
  );
  await vault.getByRole("button", { name: "Back to Vault", exact: true }).click();
  assert.equal(
    await vault
      .getByRole("region", { name: "Interrupted uploads" })
      .count(),
    0,
  );
  assert.equal(
    await vault
      .getByRole("button", {
        name: /Add passkey|Download recovery|Download encrypted backup|Unlock Vault/,
      })
      .count(),
    0,
  );
  pass(
    "actual II login; collapsed management; no second Vault factor",
    { principal: owner },
  );
  await action(vault, "Account settings");
  await vault.locator("summary").filter({ hasText: "Account & storage" }).click();
  await action(vault, "Review payment");
  await action(vault, "Pay 1 KINIC");
  await vault.getByText("Payment complete", { exact: true }).waitFor();
  pass("explicit synthetic ledger funding through real ICRC-2 calls");
  // Actual authenticated update calls through the production UI; the ledger
  // is explicitly synthetic here. Official ledger/archive proof is separate.
  const configureLedger = (mode) => execFileSync(
    "icp", ["canister", "call", "ledger", "configure", `(${mode} : nat8, 10 : nat64)`,
      "--project-root-override", process.env.VAULT_ACCEPTANCE_PROJECT,
      "-e", "acceptance", "--identity", process.env.VAULT_ACCEPTANCE_IDENTITY],
    { stdio: "inherit" },
  );
  const fundedBeforeScan = await readback(vault);
  configureLedger(6);
  await action(vault, "New payment");
  await action(vault, "Review payment");
  await action(vault, "Pay 1 KINIC");
  await vault.getByText("Payment needs a status check", { exact: true }).waitFor();
  const unknownBeforeScan = await readback(vault);
  assert.ok(BigInt(unknownBeforeScan.balance.Ok) <= BigInt(fundedBeforeScan.balance.Ok), "Unknown must not add credit; execution/storage charges may reduce balance");
  await action(vault, /^(?:Scan ledger for this payment|Resume ledger scan)$/);
  await vault.getByText(/Ledger scan: next \d+ of \d+\./).waitFor();
  await expect(vault.getByRole("button", { name: "Check payment status", exact: true })).toBeEnabled();
  const afterScan = await readback(vault);
  const financialRecords = (rows) => rows.Ok.map(({ wallet, request, config, fee, credits, memo, created_at_time, status }) =>
    ({ wallet, request, config, fee, credits, memo, created_at_time, status }));
  assert.deepEqual(financialRecords(afterScan.payments), financialRecords(unknownBeforeScan.payments));
  assert.ok(BigInt(afterScan.balance.Ok) <= BigInt(unknownBeforeScan.balance.Ok), "unproven scan must not add credit");
  // The controller schedules status-only checks at 0/1/3 seconds. Let those
  // finish while the ledger is still uncertain so the explicit status gesture
  // below cannot race an automatic check that observes the backend probe.
  await vault.waitForTimeout(3500);
  await expect(vault.getByRole("button", { name: "Check payment status", exact: true })).toBeEnabled();
  configureLedger(4);
  const unknownPayment = unknownBeforeScan.payments.Ok.find(payment => "Unknown" in payment.status);
  assert.ok(unknownPayment, "the original uncertain operation must remain in the journal");
  // Deliberate backend idempotency probe. The product UI permits status/scan
  // recovery only; it must never redispatch this uncertain payment itself.
  assert.equal(await vault.getByRole("button", { name: "Retry same payment", exact: true }).count(), 0);
  const duplicateRetry = await inspect(vault, "retryExactPurchase", canister, vaultURL, unknownPayment.request.operation);
  assert.ok("Ok" in duplicateRetry && "Paid" in duplicateRetry.Ok.status);
  await action(vault, "Check payment status");
  await vault.getByText("Payment complete", { exact: true }).waitFor();
  const recoveredScan = await readback(vault);
  assert.equal(recoveredScan.payments.Ok.length, unknownBeforeScan.payments.Ok.length);
  assert.ok(BigInt(recoveredScan.balance.Ok) > BigInt(afterScan.balance.Ok));
  configureLedger(0);
  pass("real II manual ledger update preserves Unknown without evidence and exact synthetic duplicate retry credits once; no implicit replacement");
  const beforeUpgrade = await readback(vault);
  execFileSync(
    "icp",
    [
      "canister",
      "install",
      "vault",
      "--mode",
      "upgrade",
      "--wasm",
      process.env.VAULT_ACCEPTANCE_WASM,
      "--args",
      "()",
      "--project-root-override",
      process.env.VAULT_ACCEPTANCE_PROJECT,
      "-e",
      "acceptance",
      "--identity",
      process.env.VAULT_ACCEPTANCE_IDENTITY,
    ],
    { stdio: "inherit" },
  );
  await vault.goto(vaultURL);
  await vault
    .getByRole("button", { name: "Create Vault", exact: true })
    .waitFor();
  assert.equal(
    await vault.evaluate(
      async () => (await (await fetch("/config.json")).json()).fundingMode,
    ),
    "production",
  );
  await vault.getByRole("button", { name: "Account settings", exact: true }).click();
  await vault.locator("summary").filter({ hasText: "Account & storage" }).click();
  // The production build must reject the stored synthetic ledger configuration.
  // Historical paid receipts and credit remain readable without enabling payment.
  await vault.getByText("Funding is unavailable. You can still check existing payments.", { exact: true }).waitFor();
  await expect(vault.getByRole("button", { name: "Review payment", exact: true })).toBeDisabled();
  const afterUpgrade = await readback(vault);
  assert.equal(afterUpgrade.principal, owner);
  assert.deepEqual(afterUpgrade.payments, beforeUpgrade.payments);
  assert.ok(
    BigInt(afterUpgrade.balance.Ok) > 0n &&
      BigInt(afterUpgrade.balance.Ok) <= BigInt(beforeUpgrade.balance.Ok),
  );
  pass(
    "fresh owned canister upgraded to default-feature local Wasm; certified production funding mode, paid journal and prepaid credit retained",
  );

  await vault.getByRole("button", { name: "Back to Vault", exact: true }).click();
  const createTrace = startRetryTrace("create_vault");
  dropMethod = "create_vault";
  await action(vault, "Create Vault", true);
  await vault
    .getByRole("button", { name: "Retry Vault creation", exact: true })
    .waitFor();
  const first = await readback(vault);
  assert.equal(first.headers.Ok.length, 1);
  await action(vault, "Refresh Vaults");
  assert.equal((await readback(vault)).headers.Ok.length, 1);
  const keyTrace = startRetryTrace("derive_vault_key");
  dropMethod = "derive_vault_key";
  createTrace.phase = "post-click-application-retry";
  await action(vault, "Retry Vault creation", true);
  await vault
    .getByRole("button", { name: "Retry opening Vault", exact: true })
    .waitFor();
  const afterKeyFailure = await readback(vault);
  assert.equal(afterKeyFailure.headers.Ok.length, 1);
  const createRetry = finishRetryTrace(createTrace);
  dropMethod = undefined;
  keyTrace.phase = "post-click-application-retry";
  await action(vault, "Retry opening Vault");
  await editor(vault).waitFor();
  const keyRetry = finishRetryTrace(keyTrace);
  const vaultId = first.headers.Ok[0].id;
  let sourceName = "Vault 1";
  pass(
    "lost create reply + Refresh + same create retry + lost key reply retry creates exactly one Vault",
    { retries: [createRetry, keyRetry] },
  );
  const title = "Actual II private note",
    plaintext = "actual-browser-private-payload";
  await vault.getByLabel("Document title").fill(title);
  await editor(vault).fill(plaintext);
  const chunkTrace = startRetryTrace("mutate", "SaveInline");
  dropMethod = "mutate";
  dropAction = "SaveInline";
  await action(vault, "Save document", true);
  await vault
    .getByRole("button", { name: "Resume save", exact: true })
    .waitFor();
  assert.equal(await vault.getByLabel("Document title").isDisabled(), true);
  dropMethod = undefined;
  dropAction = undefined;
  chunkTrace.phase = "post-click-application-retry";
  await action(vault, "Resume save");
  const chunkRetry = finishRetryTrace(chunkTrace);
  const search = vault.getByLabel("Search this Vault locally");
  const noteButton = vault.getByRole("button", { name: title, exact: true });
  // Save confirmation precedes the asynchronous metadata-list refresh.
  await expect(noteButton).toBeVisible();
  const readsBeforeTyping = chunkReads;
  await search.fill(plaintext);
  await expect(noteButton).toHaveCount(0);
  assert.equal(chunkReads, readsBeforeTyping, "typing must filter metadata without fetching note bodies");
  await action(vault, "Search note contents");
  await expect(noteButton).toBeVisible();
  assert.ok(chunkReads > readsBeforeTyping, "explicit search reads authenticated note contents");
  await search.fill("absent-body-query");
  await expect(noteButton).toHaveCount(0);
  await search.fill("");
  await action(vault, title);
  assert.equal(await editor(vault).innerText(), plaintext);
  const docs = await inspect(vault, "clientRead", canister, vaultURL, vaultId);
  assert.equal(docs.documents[0].plaintext, plaintext);
  const object = docs.documents[0].object;
  pass(
    "lost real SaveInline reply; frozen editor; exact resume; independent real-client decrypt",
    { retries: [chunkRetry] },
  );
  await action(vault, "New document");
  await vault.getByLabel("Document title").fill("Cancelled upload");
  await vault.getByLabel("Document type").selectOption("attachment");
  await vault.getByLabel("Attachment (10 MiB maximum)").setInputFiles({
    name: "cancelled-large.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(256 * 1024 + 1, 0x5a),
  });
  dropMethod = "mutate";
  dropAction = "PutChunk";
  await action(vault, "Save document", true);
  await vault
    .getByRole("button", { name: "Cancel save", exact: true })
    .waitFor();
  dropMethod = undefined;
  dropAction = undefined;
  await action(vault, "Cancel save");
  assert.equal((await readback(vault)).uploads.Ok.entries.length, 0);
  assert.equal(
    await vault
      .getByRole("button", { name: "Cancelled upload", exact: true })
      .count(),
    0,
  );
  pass(
    "lost real save reply cancel reconciles and clears pending server upload",
  );

  await action(vault, title);
  const cancelledUploadDiscard = vault.getByRole("dialog", { name: "Discard unsaved changes?" });
  if (await cancelledUploadDiscard.isVisible()) await cancelledUploadDiscard.getByRole("button", { name: "Discard changes" }).click();
  await action(vault, "Show version history");
  await action(vault, "View revision 1");
  const downloadEvent = vault.waitForEvent("download");
  await action(vault, "Download document");
  const download = await downloadEvent;
  assert.match(
    download.suggestedFilename(),
    /^document-[A-Za-z0-9_-]+-revision-1\.bin$/,
  );
  const stream = await download.createReadStream(),
    buffers = [];
  for await (const b of stream) buffers.push(b);
  assert.equal(Buffer.concat(buffers).toString(), plaintext);
  await retain(vault);
  await action(vault, "Close Vault");
  if (await vault.getByRole("dialog", {name:"Discard unsaved changes?"}).isVisible())
    await vault.getByRole("dialog", {name:"Discard unsaved changes?"}).getByRole("button", {name:"Discard changes"}).click();
  await assertCleared(vault);
  const blobs = await vault.evaluate(() => window.blobEvents);
  assert.ok(blobs.some(([kind]) => kind === "create"));
  for (const [, url] of blobs.filter(([kind]) => kind === "create"))
    assert.ok(blobs.some(([kind, u]) => kind === "revoke" && u === url));
  await action(vault, sourceName);
  await editor(vault).waitFor();
  await editor(vault).press("ControlOrMeta+z");
  assert.equal(
    await editor(vault).evaluate((e) =>
      e.cmTile.root.view.state.doc.toString(),
    ),
    "",
  );
  await action(vault, title);
  assert.equal(await editor(vault).innerText(), plaintext);
  pass(
    "history download bytes/name; close clears detached editor/undo/input/Blob; reopen reads same content",
  );
  await action(vault, "New document");
  await vault.getByLabel("Document type").selectOption("credential");
  await vault
    .getByLabel("Password", { exact: true })
    .fill("disposable-private-password");
  await retain(vault);
  await action(vault, "Close Vault");
  if (await vault.getByRole("dialog", {name:"Discard unsaved changes?"}).isVisible())
    await vault.getByRole("dialog", {name:"Discard unsaved changes?"}).getByRole("button", {name:"Discard changes"}).click();
  await assertCleared(vault);
  await action(vault, sourceName);
  await vault.getByLabel("Document type").selectOption("attachment");
  await vault.getByLabel("Attachment (10 MiB maximum)").setInputFiles({
    name: "private.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("private-file-draft"),
  });
  await retain(vault);
  await action(vault, "Close Vault");
  if (await vault.getByRole("dialog", {name:"Discard unsaved changes?"}).isVisible())
    await vault.getByRole("dialog", {name:"Discard unsaved changes?"}).getByRole("button", {name:"Discard changes"}).click();
  await assertCleared(vault);
  await action(vault, sourceName);
  await action(vault, title);
  pass("actual private password and File input references clear on close");

  await retain(vault);
  await action(vault, "Create Vault");
  sourceName = `Vault ${(await readback(vault)).headers.Ok.findIndex((h) => h.id.join() === vaultId.join()) + 1}`;
  await editor(vault).waitFor();
  assert.equal(
    await editor(vault).evaluate((e) =>
      e.cmTile.root.view.state.doc.toString(),
    ),
    "",
  );
  assert.equal(
    await vault.evaluate(() => window.retainedEditor.state.doc.toString()),
    "",
  );
  await vault.setViewportSize({ width: 375, height: 812 });
  assert.equal(await disclosure.count(), 0);
  const toggle = vault.getByRole("button", { name: "Toggle Vault navigation" });
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await toggle.click();
  await action(vault, sourceName);
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(
    await toggle.evaluate((e) => e === document.activeElement),
    true,
  );
  await action(vault, title);
  await vault.setViewportSize({ width: 1280, height: 900 });
  pass(
    "Vault switch clears prior draft/editor; mobile navigation/focus",
  );

  await retain(vault);
  await action(vault, "Sign out");
  await loginButton(vault).waitFor();
  await assertCleared(vault);
  await signIn(vault, loginButton(vault));
  assert.equal((await readback(vault)).principal, owner);
  await action(vault, sourceName);
  await action(vault, title);
  assert.equal(await editor(vault).innerText(), plaintext);
  pass(
    "sign out clears private views; same II relogin decrypts existing content",
  );

  await retain(vault);
  await action(vault, "Sign out");
  await loginButton(vault).waitFor();
  const storageControl = await context.newCDPSession(vault);
  // Forget only this disposable browser's II account selection, not any canister account.
  await storageControl.send("Storage.clearDataForOrigin", {
    origin: iiURL,
    storageTypes: "all",
  });
  await signIn(vault, loginButton(vault), [], true);
  assert.notEqual((await readback(vault)).principal, owner);
  assert.equal((await readback(vault)).headers.Ok.length, 0);
  await assertCleared(vault);
  const switchedDenial = await inspect(
    vault,
    "deny",
    canister,
    vaultURL,
    vaultId,
    object,
  );
  for (const key of ["header", "key", "objects", "manifest", "chunk", "config"])
    assert.ok("Err" in switchedDenial[key]);
  await action(vault, "Sign out");
  await loginButton(vault).waitFor();
  await storageControl.send("Storage.clearDataForOrigin", {
    origin: iiURL,
    storageTypes: "all",
  });
  ownerCredentials = await signIn(vault, loginButton(vault));
  assert.equal((await readback(vault)).principal, owner);
  await action(vault, sourceName);
  await action(vault, title);
  pass(
    "same production page switches real II owners, clears old private state, denies prior owner's data, then returns to original owner",
  );

  const secondContext = await browser.newContext();
  contexts.push(secondContext);
  secondContext.setDefaultTimeout(60000);
  const second = await secondContext.newPage();
  await second.goto(vaultURL);
  await inspector(second);
  ownerCredentials = await signIn(second, loginButton(second));
  assert.equal((await readback(second)).principal, owner);
  const independent = await inspect(
    second,
    "clientRead",
    canister,
    vaultURL,
    vaultId,
  );
  assert.equal(independent.documents[0].plaintext, plaintext);
  await action(second, sourceName);
  await action(second, title);
  assert.equal(await editor(second).innerText(), plaintext);
  pass(
    "second browser context with no copied app storage: same II and fresh client decrypt existing content",
  );
  await secondContext.close();
  contexts.pop();

  const otherContext = await browser.newContext();
  contexts.push(otherContext);
  otherContext.setDefaultTimeout(60000);
  const other = await otherContext.newPage();
  await other.goto(vaultURL);
  await inspector(other);
  await signIn(other, loginButton(other), [], true);
  const otherOwner = (await readback(other)).principal;
  assert.notEqual(otherOwner, owner);
  for (const anonymous of [false, true]) {
    const denied = await inspect(
      other,
      "deny",
      canister,
      vaultURL,
      vaultId,
      object,
      anonymous,
    );
    assert.ok("Err" in denied.rows || denied.rows.Ok.length === 0);
    for (const key of [
      "header",
      "key",
      "objects",
      "manifest",
      "chunk",
      "config",
    ])
      assert.ok(
        "Err" in denied[key],
        `${anonymous ? "anonymous" : "other II"} ${key}`,
      );
  }
  pass(
    "other real II account and anonymous actors denied owner header/key/content/config",
  );
  await otherContext.close();
  contexts.pop();

  const wiki = await context.newPage();
  await wiki.goto(wikiURL + "/dashboard");
  await inspector(wiki);
  ownerCredentials = await signIn(
    wiki,
    wiki.locator("[data-tid=login-button]"),
  );
  await wiki.locator('[aria-label^="Principal "]').waitFor();
  const wikiPrincipal = (
    await wiki.locator('[aria-label^="Principal "]').getAttribute("aria-label")
  ).slice("Principal ".length);
  assert.notEqual(wikiPrincipal, owner);
  const deniedWiki = await inspect(
    wiki,
    "deny",
    canister,
    vaultURL,
    vaultId,
    object,
  );
  assert.equal(deniedWiki.principal, wikiPrincipal);
  for (const key of ["header", "key", "objects", "manifest", "chunk", "config"])
    assert.ok("Err" in deniedWiki[key]);
  const popupPromise = wiki.waitForEvent("popup");
  await wiki.evaluate(
    ({ iiURL, vaultURL, key }) => {
      const popup = window.open(
        iiURL + "/#authorize",
        "vault-derivation-attack",
      );
      window.attackResult = null;
      window.addEventListener("message", (event) => {
        if (event.source !== popup || event.origin !== iiURL) return;
        if (event.data.kind === "authorize-ready")
          popup.postMessage(
            {
              kind: "authorize-client",
              sessionPublicKey: new Uint8Array(key),
              maxTimeToLive: 300000000000n,
              derivationOrigin: vaultURL,
            },
            iiURL,
          );
        if (event.data.kind === "authorize-client-success")
          window.attackResult = event.data.kind;
      });
    },
    {
      iiURL,
      vaultURL,
      key: [...Ed25519KeyIdentity.generate().getPublicKey().toDer()],
    },
  );
  const attack = await popupPromise;
  await attack.getByText("Unverified origin", { exact: true }).waitFor();
  assert.equal(await wiki.evaluate(() => window.attackResult), null);
  await attack.close();
  assert.equal(await vault.evaluate(() => window.opener === null), true);
  const crossPopup = context.waitForEvent("page");
  assert.equal(
    await wiki.evaluate(async (url) => {
      const popup = window.open(url, "vault-sop-test");
      await new Promise((r) => setTimeout(r, 1000));
      try {
        void popup.document.body;
        return false;
      } catch (e) {
        return e.name === "SecurityError";
      }
    }, vaultURL),
    true,
  );
  await (await crossPopup).close();
  const frameDenied = wiki.waitForEvent("console", {
    predicate: (message) => message.text().includes("frame-ancestors"),
    timeout: 15000,
  });
  await wiki.evaluate((url) => {
    const frame = document.createElement("iframe");
    frame.src = url;
    document.body.append(frame);
  }, vaultURL);
  await frameDenied;
  await wiki
    .locator("iframe")
    .last()
    .evaluate((frame) => frame.remove());
  await wiki.getByRole("button", { name: "Create database", exact: true }).click();
  const createDatabase = wiki.getByRole("dialog", { name: "Create database" });
  await createDatabase.getByRole("textbox", { name: "Database name" }).fill("Vault bridge acceptance");
  await createDatabase.getByRole("button", { name: "Create", exact: true }).click();
  await wiki.waitForURL(/\/db\/[^/]+\//);
  const wikiDatabaseId = new URL(wiki.url()).pathname.split("/")[2];
  const balanceBeforeBridge = BigInt((await readback(vault)).balance.Ok);
  await action(vault, "Account settings");
  const linkPopupPromise = context.waitForEvent("page", { timeout: 20000 }).catch((error) => error);
  await action(vault, "Link Wiki account");
  const linkPopup = await linkPopupPromise;
  if (linkPopup instanceof Error) throw linkPopup;
  await linkPopup.setViewportSize({ width: 390, height: 844 });
  await linkPopup.getByRole("button", { name: "Approve account link" }).click();
  assert.ok(await linkPopup.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    "mobile account linking should not overflow horizontally");
  await vault.getByText(/Wiki account linked\. Choose Charge from Wiki credits/).waitFor();
  const fundingPopupPromise = context.waitForEvent("page");
  await action(vault, "Charge from Wiki credits");
  const fundingPopup = await fundingPopupPromise;
  await fundingPopup.getByText("Connected to your Vault window.").waitFor();
  await fundingPopup.getByRole("button", { name: "Get transfer estimate" }).click();
  await fundingPopup.getByText("Quoted", { exact: true }).waitFor();
  await fundingPopup.getByRole("button", { name: "Confirm and hold credits" }).click();
  await fundingPopup.getByText("Offered", { exact: true }).waitFor();
  await fundingPopup.getByRole("button", { name: "Request Vault readiness" }).click();
  await fundingPopup.getByRole("button", { name: "Send held credits" }).click();
  await fundingPopup.getByText("Paid", { exact: true }).waitFor();
  await fundingPopup.getByText(/Fixed transfer: 1,000,000,000 cycles/).waitFor();
  const balanceAfterBridge = BigInt((await readback(vault)).balance.Ok);
  assert.ok(balanceAfterBridge > balanceBeforeBridge + 900_000_000n);
  assert.ok(balanceAfterBridge <= balanceBeforeBridge + 1_000_000_000n);
  pass("two real II principals link explicitly and move a free Wiki DB credit by an exact manual cycles transfer", {
    wikiPrincipal,
    vaultPrincipal: owner,
    recipientCycles: "1000000000",
    balanceIncreaseAfterNormalCharges: String(balanceAfterBridge - balanceBeforeBridge),
  });
  const allPopupPromise = context.waitForEvent("page");
  await action(vault, "Charge from Wiki credits");
  const allPopup = await allPopupPromise;
  await allPopup.setViewportSize({ width: 390, height: 844 });
  await allPopup.getByText("Connected to your Vault window.").waitFor();
  await allPopup.getByRole("radio", { name: "All available credits" }).check();
  await allPopup.getByRole("button", { name: "Get transfer estimate" }).click();
  await allPopup.getByText("Quoted", { exact: true }).waitFor();
  await allPopup.getByRole("checkbox", { name: /I authorize the entire available balance/ }).check();
  await allPopup.getByRole("button", { name: "Confirm and hold credits" }).click();
  await allPopup.getByText("Offered", { exact: true }).waitFor();
  await allPopup.getByRole("button", { name: "Request Vault readiness" }).click();
  await allPopup.getByRole("button", { name: "Send held credits" }).click();
  await allPopup.getByText("Paid", { exact: true }).waitFor();
  assert.ok(await allPopup.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    "mobile AllAvailable transfer should not overflow horizontally");
  pass("real II mobile-width AllAvailable confirmation fixes the execution-time DB amount and completes a second physical transfer");
  await allPopup.close();
  execFileSync("icp", ["canister", "call", "wiki", "grant_database_cycles_from_iap",
    `(record {database_id="${wikiDatabaseId}";provider="apple_iap";product_id="test.cycles";external_payment_id="browser-credit-recovery";purchaser_principal="${wikiPrincipal}";amount_cycles=3000000000:nat64})`,
    "--candid", new URL("../../crates/vfs_canister/vfs.did", import.meta.url).pathname,
    "--project-root-override", process.env.VAULT_ACCEPTANCE_PROJECT,
    "-e", "acceptance", "--identity", process.env.VAULT_ACCEPTANCE_IDENTITY],
  { stdio: "inherit" });
  const lostCreditPopupPromise = context.waitForEvent("page");
  await action(vault, "Charge from Wiki credits");
  const lostCreditPopup = await lostCreditPopupPromise;
  await lostCreditPopup.getByText("Connected to your Vault window.").waitFor();
  await lostCreditPopup.getByRole("button", { name: "Get transfer estimate" }).click();
  await lostCreditPopup.getByText("Quoted", { exact: true }).waitFor();
  await lostCreditPopup.getByRole("button", { name: "Confirm and hold credits" }).click();
  await lostCreditPopup.getByText("Offered", { exact: true }).waitFor();
  await lostCreditPopup.getByRole("button", { name: "Request Vault readiness" }).click();
  let droppedCreditReplies = 0;
  const dropCreditReply = async (route) => {
    const body = route.request().postDataBuffer();
    const method = body ? Cbor.decode(body).content?.method_name : undefined;
    if (method !== "execute_vault_transfer") return route.continue();
    const response = await route.fetch();
    assert.ok(response.ok(), "real Wiki ingress should finish before losing its HTTP reply");
    droppedCreditReplies++;
    await route.abort("failed");
  };
  await lostCreditPopup.route("**/api/v*/canister/**/call", dropCreditReply);
  const beforeLostCredit = BigInt((await readback(vault)).balance.Ok);
  await lostCreditPopup.getByRole("button", { name: "Send held credits" }).click();
  await lostCreditPopup.getByText(/Request did not complete\. Refresh saved status before retrying/).waitFor();
  assert.ok(droppedCreditReplies > 0);
  await lostCreditPopup.unroute("**/api/v*/canister/**/call", dropCreditReply);
  await lostCreditPopup.getByRole("button", { name: "Refresh transfer status" }).click();
  await lostCreditPopup.getByText("Paid", { exact: true }).waitFor();
  await lostCreditPopup.getByRole("button", { name: "Reconcile transfer" }).click();
  await lostCreditPopup.getByText("Paid", { exact: true }).waitFor();
  const afterLostCredit = BigInt((await readback(vault)).balance.Ok);
  assert.ok(afterLostCredit > beforeLostCredit + 900_000_000n);
  assert.ok(afterLostCredit <= beforeLostCredit + 1_000_000_000n);
  pass("real II Wiki physical send survives lost HTTP replies and manual refresh/reconcile credits exactly once", {
    droppedCreditReplies, balanceIncreaseAfterNormalCharges: String(afterLostCredit - beforeLostCredit),
  });
  await lostCreditPopup.close();
  const heldPopupPromise = context.waitForEvent("page");
  await action(vault, "Charge from Wiki credits");
  const heldPopup = await heldPopupPromise;
  await heldPopup.setViewportSize({ width: 390, height: 844 });
  await heldPopup.getByText("Connected to your Vault window.").waitFor();
  await heldPopup.getByRole("button", { name: "Get transfer estimate" }).click();
  await heldPopup.getByText("Quoted", { exact: true }).waitFor();
  await heldPopup.getByRole("button", { name: "Confirm and hold credits" }).click();
  await heldPopup.getByText("Offered", { exact: true }).waitFor();
  await heldPopup.close();
  const recoveryPopupPromise = context.waitForEvent("page");
  await action(vault, "Charge from Wiki credits");
  const recoveryPopup = await recoveryPopupPromise;
  await recoveryPopup.setViewportSize({ width: 390, height: 844 });
  await recoveryPopup.getByText("Offered", { exact: true }).waitFor();
  await recoveryPopup.getByRole("button", { name: "Cancel unsent transfer" }).click();
  await recoveryPopup.getByText("Refunded", { exact: true }).waitFor();
  assert.ok(await recoveryPopup.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    "mobile credit recovery should not overflow horizontally");
  pass("real II mobile-width held transfer survives a closed Wiki window and the owner cancels the recovered unsent receipt");
  const savedRecoveryUrl = recoveryPopup.url();
  await recoveryPopup.close();
  await action(vault, "Revoke Wiki link");
  await vault.getByText(/Wiki principal: .* · Revoked/).waitFor();
  const relinkPopupPromise = context.waitForEvent("page");
  await action(vault, "Link Wiki account");
  const relinkPopup = await relinkPopupPromise;
  await relinkPopup.getByRole("button", { name: "Approve account link" }).click();
  await vault.getByText(/Wiki account linked\. Choose Charge from Wiki credits/).waitFor();
  pass("Vault revocation blocks new funding and the same real II Wiki/Vault principal pair can explicitly relink");
  await relinkPopup.getByRole("button", { name: "Revoke account link" }).click();
  await action(vault, "Refresh Wiki link");
  await vault.getByText(/Wiki principal: .* · Revoked/).waitFor();
  pass("Wiki-side account revocation propagates to the authenticated Vault status");
  await relinkPopup.close();
  const staleCreditPage = await context.newPage();
  await staleCreditPage.goto(savedRecoveryUrl);
  await staleCreditPage.getByText("Refunded", { exact: true }).waitFor();
  let wikiReplyReady;
  let wikiReplyDelivered;
  let releaseWikiReply;
  const pendingWikiReply = new Promise((resolve) => { wikiReplyReady = resolve; });
  const deliveredWikiReply = new Promise((resolve) => { wikiReplyDelivered = resolve; });
  const delayWikiReply = async (route) => {
    const body = route.request().postDataBuffer();
    const method = body ? Cbor.decode(body).content?.method_name : undefined;
    if (method !== "get_vault_transfer") return route.continue();
    const response = await route.fetch();
    assert.ok(response.ok(), "delayed Wiki status must come from actual canister ingress");
    wikiReplyReady();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("Delayed Wiki reply was not released")), 30000);
      releaseWikiReply = () => { clearTimeout(timeout); resolve(); };
    });
    await route.fulfill({ response });
    wikiReplyDelivered();
  };
  await staleCreditPage.route("**/api/v*/canister/**/call", delayWikiReply);
  await staleCreditPage.getByRole("button", { name: "Refresh transfer status" }).click();
  await Promise.race([pendingWikiReply, staleCreditPage.waitForTimeout(30000).then(() => {
    throw Error("Expected actual Wiki transfer status interception");
  })]);
  await staleCreditPage.getByRole("button", { name: "Sign out of Wiki" }).click();
  await staleCreditPage.getByRole("button", { name: "Sign in with Internet Identity" }).waitFor();
  releaseWikiReply();
  await deliveredWikiReply;
  await staleCreditPage.unroute("**/api/v*/canister/**/call", delayWikiReply);
  await staleCreditPage.waitForTimeout(300);
  assert.equal(await staleCreditPage.getByText("Refunded", { exact: true }).count(), 0);
  pass("late real Wiki transfer reply after logout cannot restore the old receipt");
  await staleCreditPage.close();
  await wiki.close();
  pass(
    "same II Wiki principal separation; real II derivation-origin attack denied; SOP/opener/frame CSP",
  );

  // Delay an actual private read, switch context, then deliver its real plaintext-producing reply.
  await action(vault, "Back to Vault");
  await action(vault, "New document");
  delayMethod = "get_chunk";
  const ready = new Promise((resolve) => {
    delayedReady = resolve;
  });
  await vault.getByRole("button", { name: title, exact: true }).click();
  await Promise.race([
    ready,
    vault.waitForTimeout(30000).then(() => {
      throw Error("Expected real get_chunk interception");
    }),
  ]);
  await action(vault, "Close Vault");
  releaseResponse();
  await vault.waitForTimeout(1000);
  await assertCleared(vault);
  assert.equal(
    (await vault.locator("body").innerText()).includes(plaintext),
    false,
  );
  pass("late real read reply after close cannot restore editor or plaintext");

  // Reopening normally reuses the persistent key. Explicitly forget it so this
  // race test still intercepts a real derivation rather than a cache hit.
  await action(vault, "Account settings");
  await action(vault, "Delete saved keys from this browser");
  assertDeviceKeyStore(await vault.evaluate(readDeviceKeyStore), `${canister}:${owner}`);
  assert.equal((await vault.evaluate(readDeviceKeyStore)).records.filter(record => record.key).length, 0);
  await action(vault, "Back to Vault");
  delayMethod = "derive_vault_key";
  const keyReady = new Promise((resolve) => {
    delayedReady = resolve;
  });
  await vault.getByRole("button", { name: sourceName, exact: true }).click();
  await Promise.race([
    keyReady,
    vault.waitForTimeout(30000).then(() => {
      throw Error("Expected real derive_vault_key interception");
    }),
  ]);
  await action(vault, "Sign out");
  await loginButton(vault).waitFor();
  releaseResponse();
  await vault.waitForTimeout(1000);
  await assertCleared(vault);
  await signIn(vault, loginButton(vault));
  assert.equal((await readback(vault)).principal, owner);
  assert.equal(await editor(vault).count(), 0);
  pass(
    "late real key reply after logout cannot reinstall old client root or private UI; same-owner new login remains closed",
  );

  await action(vault, sourceName);
  await action(vault, title);
  const persistence = await vault.evaluate(
    async (secrets) => {
      const databases = [];
      for (const entry of await indexedDB.databases()) {
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open(entry.name);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        const stores = [];
        for (const name of db.objectStoreNames) {
          const store = db.transaction(name).objectStore(name);
          const request = (r) =>
            new Promise((resolve, reject) => {
              r.onsuccess = () => resolve(r.result);
              r.onerror = () => reject(r.error);
            });
          const [keys, values] = await Promise.all([
            request(store.getAllKeys()),
            request(store.getAll()),
          ]);
          const algorithms = [];
          const publicNodeKeyCache =
            name === "subnetNodeKeys" &&
            values.every(
              (record) =>
                Object.keys(record).sort().join() === "key,timestamp,value" &&
                typeof record.key === "string" &&
                typeof record.timestamp === "number" &&
                record.value instanceof Map &&
                [...record.value].every(
                  ([node, key]) =>
                    typeof node === "string" &&
                    key instanceof Uint8Array &&
                    key.length === 44 &&
                    Array.from(key.slice(0, 12)).join() ===
                      "48,42,48,5,6,3,43,101,112,3,33,0",
                ),
            );
          const serialized = JSON.stringify(values, (_, value) => {
            if (value instanceof Map) return [...value];
            if (value instanceof CryptoKey) {
              algorithms.push(value.algorithm.name);
              return { cryptoAlgorithm: value.algorithm.name };
            }
            return value;
          });
          stores.push({
            name,
            keys,
            algorithms,
            publicNodeKeyCache,
            plaintextFound: secrets.some((secret) =>
              serialized.includes(secret),
            ),
          });
        }
        db.close();
        databases.push({ name: entry.name, stores });
      }
      return {
        databases,
        localKeys: Object.keys(localStorage),
        sessionKeys: Object.keys(sessionStorage),
        cacheNames: await caches.keys(),
        serviceWorkers: (await navigator.serviceWorker.getRegistrations())
          .length,
        credentialCalls: window.vaultCredentialCalls,
      };
    },
    [plaintext, title, "cancelled-private-payload"],
  );
  assert.deepEqual(persistence.localKeys, []);
  assert.deepEqual(persistence.sessionKeys, []);
  assert.deepEqual(persistence.cacheNames, []);
  assert.equal(persistence.serviceWorkers, 0);
  assert.equal(persistence.credentialCalls, 0);
  const network = new URL(vaultURL);
  const allowedDatabases = [
    "auth-client-db",
    "kinic-vault-device-keys-v1",
    `icp-sdk-${network.host}`,
    `icp-sdk-localhost:${network.port}`,
  ];
  assert.ok(persistence.databases.some((db) => db.name === "auth-client-db"));
  assert.ok(
    persistence.databases.every((db) => allowedDatabases.includes(db.name)),
    "Only SDK authentication, scoped non-extractable Vault roots and public subnet-key caches may persist",
  );
  for (const db of persistence.databases)
    for (const store of db.stores) {
      assert.equal(store.plaintextFound, false);
      if (db.name === "auth-client-db") {
        assert.equal(store.name, "ic-keyval");
        assert.ok(
          store.keys.every((key) =>
            ["identity", "delegation", "iv"].includes(key),
          ),
        );
        assert.ok(
          store.algorithms.every((name) => name === "ECDSA"),
          "No AES Vault root or DEK may persist",
        );
      } else if (db.name === "kinic-vault-device-keys-v1") {
        assert.equal(store.name, "entries");
        assert.ok(store.algorithms.every(name => name === "AES-GCM"));
      } else {
        assert.equal(store.name, "subnetNodeKeys");
        assert.equal(
          store.publicNodeKeyCache,
          true,
          "SDK cache must contain only timestamped DER public Ed25519 subnet keys",
        );
        assert.deepEqual(store.algorithms, []);
      }
    }
  const deviceStore = await vault.evaluate(readDeviceKeyStore);
  assertDeviceKeyStore(deviceStore, `${canister}:${owner}`);
  assert.ok(deviceStore.records.some(record => record.key), "reopened Vault must save its verified root");
  pass(
    "no Vault plaintext/raw-key/DEK persistence; only scoped non-extractable roots, SDK auth and public subnet keys; zero Vault WebAuthn calls",
    { databases: persistence.databases.map((db) => db.name) },
  );

  // Short actual II delegation, same SDK storage, then production restore. No browser clock changes.
  await action(vault, "Sign out");
  await loginButton(vault).waitFor();
  const shortPopup = vault.waitForEvent("popup");
  const shortStarted = Date.now();
  const shortLogin = inspect(vault, "shortLogin", iiURL, vaultURL, 35);
  ownerCredentials = await completeLogin(await shortPopup, ownerCredentials);
  await shortLogin;
  await vault.reload();
  await vault
    .getByRole("button", { name: "Create Vault", exact: true })
    .waitFor();
  const expiry = (
    await inspect(vault, "captureExpiry", canister, vaultURL)
  ).map(BigInt);
  const earliest = expiry.reduce((a, b) => (a < b ? a : b));
  assert.ok(earliest > BigInt(Date.now()) * 1000000n);
  assert.ok(
    earliest < BigInt(shortStarted + 55000) * 1000000n,
    "Actual signed II expiration must be short",
  );
  await action(vault, sourceName);
  await action(vault, title);
  await retain(vault);
  while (Date.now() < Number(earliest / 1000000n) + 3000) {
    if (await editor(vault).count())
      await editor(vault)
        .press("x")
        .catch(() => {});
    await vault.waitForTimeout(300);
  }
  await loginButton(vault).waitFor();
  await assertCleared(vault);
  const expiredIngress = [];
  const observeExpiry = async (response) => {
    if (
      /\/api\/v[0-9]+\/canister\/.*\/call$/.test(response.url()) &&
      response.status() >= 400
    )
      expiredIngress.push({
        status: response.status(),
        body: await response.text(),
      });
  };
  vault.on("response", observeExpiry);
  const expired = await inspect(vault, "retainedCall");
  vault.off("response", observeExpiry);
  assert.equal(expired.accepted, false);
  assert.match(expired.error, /expir|delegation/i);
  assert.ok(
    expiredIngress.some((response) => /expir/i.test(response.body)),
    "Replica HTTP rejection must confirm actual delegation expiry",
  );
  pass(
    "active typing across real II signed expiry clears UI; captured old actor rejected by replica",
    {
      ttlRequestedSeconds: 35,
      signedExpirationNs: earliest.toString(),
      browserClockManipulated: false,
      replicaStatuses: expiredIngress.map((r) => r.status),
    },
  );

  await signIn(vault, loginButton(vault));
  await action(vault, sourceName);
  await action(vault, title);
  await retain(vault);
  const idleExpirations = await inspect(
    vault,
    "captureExpiry",
    canister,
    vaultURL,
  );
  const idleExpiry = idleExpirations
    .map(BigInt)
    .reduce((a, b) => (a < b ? a : b));
  const idleStart = Date.now();
  assert.ok(
    idleExpiry > BigInt(idleStart + 35 * 60 * 1000) * 1000000n,
    "Fresh normal-login signed delegation must outlast the entire idle test",
  );
  console.log(
    "WAIT actual 30-minute idle; signed normal delegation expiry",
    idleExpiry.toString(),
  );
  await loginButton(vault).waitFor({ timeout: 1830000 });
  assert.ok(Date.now() - idleStart >= 1790000);
  await assertCleared(vault);
  const idleEnded = Date.now();
  assert.ok(
    BigInt(idleEnded) * 1000000n < idleExpiry,
    "Idle logout must occur before signed delegation expiry",
  );
  const stillValid = await inspect(vault, "retainedCall");
  assert.equal(
    stillValid.accepted,
    true,
    "A retained signing identity remains valid after local idle logout until expiry",
  );
  assert.deepEqual(stillValid.expirations, idleExpirations);
  pass(
    "natural 30-minute idle logout clears retained private UI before signed expiry; retained signer remains valid",
    {
      elapsedMs: idleEnded - idleStart,
      signedExpirationsBefore: idleExpirations,
      signedExpirationsAfter: stillValid.expirations,
      signedRemainingAfterIdleMs: Number(idleExpiry / 1000000n) - idleEnded,
      retainedActorAcceptedAfterLocalLogout: stillValid.accepted,
    },
  );
  await signIn(vault, loginButton(vault));
  assert.equal((await readback(vault)).principal, owner);
  assert.equal(
    (await inspect(vault, "clientRead", canister, vaultURL, vaultId))
      .documents[0].plaintext,
    plaintext,
  );
  pass(
    "same II recovers access after expiry and idle without independent Vault secret",
  );
  writeFileSync(
    out + "results.json",
    JSON.stringify(
      {
        passed: results.length,
        results,
        browser: browser.version(),
        clock: "real",
        realFunds: false,
        productionDeployment: false,
      },
      null,
      2,
    ) + "\n",
  );
} catch (e) {
  writeFileSync(
    out + "partial-results.json",
    JSON.stringify({ results, failure: String(e) }, null, 2) + "\n",
  );
  for (const ctx of contexts)
    for (const [i, page] of ctx.pages().entries()) {
      console.error(
        "PAGE",
        i,
        page.url(),
        "BUTTONS",
        await page
          .getByRole("button")
          .allTextContents()
          .catch(() => []),
        "ALERTS",
        await page
          .getByRole("alert")
          .allTextContents()
          .catch(() => []),
      );
      await page
        .screenshot({
          path: out + `failure-${contexts.indexOf(ctx)}-${i}.png`,
          fullPage: true,
        })
        .catch(() => {});
    }
  throw e;
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
}
