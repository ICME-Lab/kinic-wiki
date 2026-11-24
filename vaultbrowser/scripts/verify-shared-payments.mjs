// Requires the fresh manifest and four explicit URLs from run-vault-browser-acceptance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { build } from "../node_modules/vite/dist/node/index.js";
import {
  chromium,
  expect,
} from "../../wikibrowser/node_modules/@playwright/test/index.mjs";
import { readDeployment } from "./shared-payment-preflight.mjs";
import { Principal } from "@icp-sdk/core/principal";
import { IDL } from "@icp-sdk/core/candid";
import { idlFactory as vaultIdl } from "../../packages/vault-candid/index.js";
import { completeLocalLogin } from "./local-ii.mjs";

const [manifest, wikiURL, vaultURL, iiURL, signerURL] = process.argv.slice(2);
for (const raw of [wikiURL, vaultURL, iiURL, signerURL]) {
  const u = new URL(raw);
  assert.ok(
    u.protocol === "http:" &&
      !u.username &&
      !u.password &&
      u.port &&
      (["localhost", "127.0.0.1"].includes(u.hostname) ||
        u.hostname.endsWith(".localhost")),
    "Owned local URLs required",
  );
}
const root = resolve(import.meta.dirname, "../..");
const setup = JSON.parse(readFileSync(manifest, "utf8"));
const project = realpathSync(dirname(manifest));
assert.equal(project, realpathSync(setup.project));
assert.equal(dirname(project), realpathSync(join(root, "target")));
assert.match(basename(project), /^vault-browser-network-/);
assert.equal(process.env.ICP_HOME, join(project, "cli-home"));
for (const [key, url] of Object.entries({
  wikiURL,
  vaultURL,
  iiURL,
  signerURL,
}))
  assert.equal(setup[key], url);
const { ids, replica } = setup;
const port = new URL(vaultURL).port;
assert.equal(replica, "http://127.0.0.1:" + port);
assert.equal(vaultURL, `http://${ids.vault}.localhost:${port}`);
assert.equal(iiURL, `http://${ids.ii_frontend}.localhost:${port}`);
assert.equal(signerURL, "http://localhost:" + port + "/sign");
assert.equal(
  createHash("sha256")
    .update(readFileSync(join(project, "vault-synthetic-local.wasm")))
    .digest("hex"),
  setup.wasmSha256,
);
const cliArgs = [
  "--project-root-override",
  project,
  "-e",
  "acceptance",
  "--identity",
  "vault-browser-fixture",
];
const icp = (args) =>
  execFileSync("icp", [...args, ...cliArgs], {
    encoding: "utf8",
    env: { ...process.env, DO_NOT_TRACK: "1" },
  });
for (const key of ["wiki", "vault", "ii", "ii_frontend", "ledger"])
  assert.equal(icp(["canister", "status", key, "--id-only"]).trim(), ids[key]);
const fee = (value) =>
  icp([
    "canister",
    "call",
    "ledger",
    "configure",
    `(0 : nat8, ${value} : nat64)`,
  ]);
const config = JSON.parse(
  execFileSync("curl", [
    "--noproxy",
    "*",
    "--resolve",
    new URL(vaultURL).hostname + ":" + port + ":127.0.0.1",
    "-fsS",
    vaultURL + "/config.json",
  ]),
);
assert.equal(config.origin, vaultURL);
assert.equal(config.local, true);
assert.equal(config.canister, ids.vault);
assert.equal(config.identityProvider, iiURL);
assert.equal(config.fundingMode, "synthetic-test-only");
assert.equal(config.host, "http://localhost:" + port);
const preflight = await readDeployment(setup);
await assert.rejects(readDeployment({...setup, wasmSha256:"0".repeat(64)}), /Unexpected installed Vault module/);
await assert.rejects(readDeployment({...setup, ids:{...ids, ledger:ids.vault}}), /Unexpected Wiki billing ledger/);
preflight.rejectedWrongModuleAndLedger = true;
const bundle = await build({
  configFile: false,
  root,
  logLevel: "warn",
  build: {
    write: false,
    lib: {
      entry: join(root, "vaultbrowser/fixtures/payments/wallet.ts"),
      name: "LocalPaymentWallet",
      formats: ["iife"],
    },
    rollupOptions: { output: { codeSplitting: false } },
  },
});
const code = bundle[0].output.find((x) => x.type === "chunk").code;
const require = createRequire(import.meta.url);
const { Cbor } = require("@icp-sdk/core/agent");
const allowedOrigins = new Set([
  wikiURL,
  vaultURL,
  iiURL,
  replica,
  config.host,
  `http://${ids.ii}.localhost:${port}`,
]);
const browser = await chromium.launch({
  headless: true,
  args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
});
const rows = [];
const file = join(project, "shared-payment-results.json");
const money = [
  "beneficiary_pay_purchase",
  "icrc2_approve",
  "pay_purchase",
  "purchase_database_cycles",
  "quote_purchase",
];
const wikiModules = Object.fromEntries(
  [
    "wikibrowser/lib/payments/cycles-adapter.ts",
    "wikibrowser/lib/vfs-client/actor.ts",
    "wikibrowser/app/cycles/cycles-client.tsx",
    "wikibrowser/src/routes/cycles.tsx",
    "wikibrowser/src/routes/__root.tsx",
    "wikibrowser/app/app-session-provider.tsx",
    "wikibrowser/app/wiki-wallet-lifetime.tsx",
  ].map((path) => [
    path,
    createHash("sha256")
      .update(readFileSync(join(root, path)))
      .digest("hex"),
  ]),
);
const save = () =>
  writeFileSync(
    file,
    JSON.stringify(
      {
        sourceCommit: setup.sourceCommit,
        wikiModules,
        sourceDiffSha256: setup.sourceDiffSha256,
        wasmSha256: setup.wasmSha256,
        providerFixtureSha256: createHash("sha256").update(code).digest("hex"),
        preflight,
        rows,
      },
      null,
      2,
    ),
  );
const button = (page, name) => {
  const root =
    /^(?:Connect|Disconnect|Reconnect|Authorize) (?:Plug|OISY)$/.test(name)
      ? page.getByRole("group", { name: "Payment source" })
      : page;
  return root.getByRole("button", { name, exact: true });
};
// Vault payment reads and submissions use the signed-in beneficiary, not the payer wallet.
const vaultPurchase = "beneficiary_pay_purchase";
const vaultStatus = vaultIdl({ IDL })._fields.find(([name]) => name === "beneficiary_payment_status")[1];
// The installed Candid reader starts at the backing buffer origin. Copy pooled Node/CBOR views.
const decodeCandid = (types, bytes) => IDL.decode(types, Uint8Array.from(bytes));
const wikiPendingResult = IDL.Variant({Ok: IDL.Vec(IDL.Reserved), Err: IDL.Text});

async function observeRecovery(route, content, record) {
  const {scope, id} = record;
  const wiki = scope.target.kind === "wiki";
  const reader = wiki ? scope.payer.owner : scope.target.beneficiary;
  if (Principal.fromUint8Array(content.sender).toText() !== reader ||
      Principal.fromUint8Array(content.canister_id).toText() !== scope.spender) return null;
  if (content.method_name !== (wiki ? "list_database_cycles_pending_purchases" : "beneficiary_payment_status")) return null;
  const args = decodeCandid(wiki ? [IDL.Text] : vaultStatus.argTypes, content.arg);
  const arg = wiki ? args[0] : args[1];
  if (!wiki && args[0].toText() !== scope.payer.owner) return null;
  if (wiki ? arg !== scope.target.databaseId : Buffer.from(arg).toString("hex") !== id) return null;
  const response = await route.fetch();
  const envelope = Cbor.decode(await response.body());
  assert.equal(envelope.status, "replied");
  const [result] = decodeCandid(wiki ? [wikiPendingResult] : vaultStatus.retTypes, envelope.reply.arg);
  const observation = {
    method: content.method_name,
    localJournalId: id,
    payer: Principal.fromUint8Array(content.sender).toText(),
    canister: Principal.fromUint8Array(content.canister_id).toText(),
  };
  if (wiki) {
    observation.correlation = "original journal payer and target database";
    observation.databaseId = arg;
    if ("Err" in result) {
      const expected = "principal cannot view pending cycle purchases: " + arg;
      assert.ok(result.Err === expected || result.Err === "sqlite error 1: " + expected);
      observation.pendingReply = result.Err;
    } else observation.pendingRows = result.Ok.length;
  } else {
    assert.ok("Ok" in result && result.Ok.length === 1);
    const payment = result.Ok[0];
    assert.equal(Buffer.from(payment.request.operation).toString("hex"), id);
    assert.equal(payment.wallet.toText(), scope.payer.owner);
    assert.equal(payment.request.beneficiary.toText(), scope.target.beneficiary);
    observation.correlation = "original operation in status request and returned payment";
    observation.requestedOperation = Buffer.from(arg).toString("hex");
    observation.returnedOperation = Buffer.from(payment.request.operation).toString("hex");
    observation.beneficiary = payment.request.beneficiary.toText();
    observation.status = Object.keys(payment.status)[0];
    if ("Paid" in payment.status) observation.reference = payment.status.Paid.toString();
  }
  await route.fulfill({response});
  return observation;
}

async function settings(page) {
  await button(page, "Account settings").click();
  const summary = page
    .locator("summary")
    .filter({ hasText: "Account & storage" });
  if (!(await summary.evaluate((s) => s.parentElement.open)))
    await summary.click();
}
async function wikiDatabase(page) {
  await page.goto(wikiURL + "/dashboard");
  await button(page, "Create database").click();
  const dialog = page.getByRole("dialog", { name: "Create database" });
  await dialog
    .getByRole("textbox", { name: "Database name" })
    .fill("Shared payment acceptance");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/db\/[^/]+\//);
  return (
    wikiURL +
    "/cycles?database_id=" +
    new URL(page.url()).pathname.split("/")[2]
  );
}
try {
  for (const app of ["Wiki", "Vault"]) {
    fee(app === "Wiki" ? 100000 : 10);
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const ctx = await browser.newContext({
        viewport,
        serviceWorkers: "block",
      });
      ctx.setDefaultTimeout(15_000);
      let dropMethod, dropped, releaseResponse, recoveryRecord;
      const observations = [];
      const observationErrors = [];
      const holdResponse = new Promise(resolve => {releaseResponse = resolve;});
      const counts = {},
        messages = [];
      const bump = (k) => {
        counts[k] = (counts[k] ?? 0) + 1;
      };
      await ctx.exposeBinding("recordLocalWalletEvent", ({ frame }, event) => {
        assert.ok(allowedOrigins.has(new URL(frame.url()).origin));
        bump(event);
      });
      ctx.on("page", (p) => {
        p.on("domcontentloaded", () => {
          if (p.url() === signerURL) bump("signerPopup");
        });
        p.on("pageerror", (e) => messages.push(String(e)));
        p.on("console", (m) => {
          if (m.type() === "error") messages.push(m.text().slice(0, 300));
        });
      });
      await ctx.addInitScript({
        content:
          code +
          ";LocalPaymentWallet.install(" +
          JSON.stringify({ ...setup, seed: [...randomBytes(32)] }) +
          ");",
      });
      await ctx.route("**/*", async (route) => {
        const req = route.request(),
          url = new URL(req.url());
        if (!allowedOrigins.has(url.origin)) return route.abort();
        if (req.url() === signerURL)
          return route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Disposable local signer</title><p>Synthetic test funding. No real KINIC is used.</p>",
          });
        if (/\/api\/v\d+\/canister\/[^/]+\/(call|query)$/.test(url.pathname)) {
          const content = Cbor.decode(req.postDataBuffer()).content;
          if (recoveryRecord && url.pathname.endsWith("/query") &&
              ["beneficiary_payment_status", "list_database_cycles_pending_purchases"].includes(content.method_name)) {
            try {
              const observation = await observeRecovery(route, content, recoveryRecord);
              if (observation) { observations.push(observation); return; }
            } catch (error) {
              observationErrors.push(String(error));
              return route.abort().catch(() => {});
            }
          }
          if (money.includes(content.method_name)) {
            const expected =
              content.method_name === "icrc2_approve"
                ? ids.ledger
                : content.method_name === "purchase_database_cycles"
                  ? ids.wiki
                  : ids.vault;
            assert.equal(url.pathname.split("/")[4], expected);
            bump(content.method_name);
            if (content.method_name === dropMethod) {
              if (dropped) return route.abort();
              const response = await route.fetch();
              assert.ok(
                response.ok(),
                "The owned replica must first accept the signed ingress",
              );
              dropped = { method: dropMethod, httpStatus: response.status() };
              await holdResponse;
              return route.abort("aborted").catch(() => {});
            }
          }
        }
        return route.continue();
      });
      const page = await ctx.newPage();
      const pageRow = { app, viewport, providers: [] };
      rows.push(pageRow);
      try {
        let formURL =
          app === "Wiki"
            ? wikiURL + "/cycles?database_id=" + setup.databaseId
            : vaultURL;
        await page.goto(formURL);
        const popup = page.waitForEvent("popup");
        const login =
          app === "Wiki"
            ? page.locator('[data-tid="cycles-login-button"]')
            : button(page, "Sign in with Internet Identity");
        await login.click();
        await completeLocalLogin(iiURL, await popup, [], true);
        if (app === "Wiki") {
          if (viewport.width === 1280) {
            const payer = await page.getByRole("group", {name:"Payment source"}).locator("span.font-mono").innerText();
            assert.equal(Principal.fromText(payer).toText(), payer);
            assert.notEqual(payer, Principal.anonymous().toText());
            const grant = icp(["canister", "call", "wiki", "grant_database_access",
              "(" + JSON.stringify(setup.databaseId) + ", " + JSON.stringify(payer) + ", variant { Reader })",
              "--candid", join(root, "crates/vfs_canister/vfs.did"), "--output", "hex"]);
            assert.deepEqual(decodeCandid([IDL.Variant({Ok:IDL.Null, Err:IDL.Text})], Buffer.from(grant.trim(),"hex")), [{Ok:null}]);
            await page.reload();
            const beforeReader = {...counts};
            await button(page, "Review payment").click();
            await button(page, "Pay 1 KINIC").click();
            await expect(page.getByText("Payment complete", {exact:true})).toBeVisible({timeout:30_000});
            assert.equal(counts.purchase_database_cycles - (beforeReader.purchase_database_cycles ?? 0), 1);
            pageRow.linkedReader = {databaseId: setup.databaseId, payer, role: "Reader", confirmedPurchases: 1};
          }
          formURL = await wikiDatabase(page);
          await page.goto(formURL);
        } else await settings(page);
        for (const provider of ["Internet Identity", "OISY", "Plug"]) {
          const row = { provider, before: { ...counts }, paid: 0 };
          pageRow.providers.push(row);
          try {
            await page
              .getByRole("radio", { name: provider, exact: true })
              .check();
            await expect(
              page.getByText("Synthetic test funding. No real KINIC is used.", {
                exact: true,
              }),
            ).toBeVisible();
            if (provider !== "Internet Identity")
              await button(page, "Connect " + provider).click();
            for (let i = 0; i < 2; i++) {
              const before = { ...counts };
              await button(page, "Review payment").click();
              const pay = button(page, "Pay 1 KINIC");
              await expect(pay).toBeEnabled();
              await pay.evaluate((el) => {
                el.click();
                el.click();
              });
              await expect(
                page.getByText("Payment complete", { exact: true }),
              ).toBeVisible({ timeout: 30_000 });
              const purchase =
                app === "Wiki" ? "purchase_database_cycles" : vaultPurchase;
              assert.equal(counts[purchase] - (before[purchase] ?? 0), 1);
              if (app === "Vault") assert.equal(counts.pay_purchase ?? 0, 0, "Vault never asks the payer to sign the purchase");
              assert.equal(
                counts.icrc2_approve - (before.icrc2_approve ?? 0),
                1,
              );
              if (app === "Wiki" && provider === "OISY") {
                const reads = "consent:list_database_cycles_pending_purchases";
                assert.ok(counts[reads] - (before[reads] ?? 0) >= 3, "review and both revalidations obtained Wiki consent");
                assert.equal(counts["consent:purchase_database_cycles"] - (before["consent:purchase_database_cycles"] ?? 0), 1);
              }
              if (app === "Vault" && provider === "OISY") {
                // OISY is asked only to quote and approve. Reads and submission use the beneficiary.
                const delta = (k) => (counts[k] ?? 0) - (before[k] ?? 0);
                assert.equal(delta("consent:quote_purchase"), 1);
                for (const read of ["list_payments", "payment_status", "pay_purchase"])
                  assert.equal(delta("consent:" + read), 0, "OISY was asked to sign " + read);
                assert.equal(delta("signed:quote_purchase") + delta("signed:icrc2_approve"), 2);
                assert.equal(delta("signerPopup"), 2, "Review and Pay each open one OISY tab");
              }
              row.paid++;
              if (app === "Wiki") {
                await button(page, "View database").click();
                const target = new URL(formURL).searchParams.get("database_id");
                await page.getByRole("link", {name:"Top up", exact:true})
                  .and(page.locator(`a[href="/cycles?database_id=${target}"],a[href^="/cycles?database_id=${target}&"]`)).click();
              } else {
                await button(page, "Back to Vault").click();
                await settings(page);
              }
              if (provider !== "Internet Identity")
                await expect(
                  button(page, "Disconnect " + provider),
                ).toBeVisible();
            }
            if (provider !== "Internet Identity") {
              const grant = provider === "OISY" ? "signerPopup" : "plugGrant";
              assert.equal(
                counts[grant] - (row.before[grant] ?? 0),
                // Vault closes OISY after each signature: Connect plus Review and Pay twice.
                app === "Vault" && provider === "OISY" ? 5 : 1,
                "Two payments share the connected wallet",
              );
              if (provider === "OISY")
                assert.equal(
                  counts["signed:icrc2_approve"] -
                    (row.before["signed:icrc2_approve"] ?? 0),
                  2,
                );
              const beforeReload = Object.fromEntries(
                money.map((k) => [k, counts[k] ?? 0]),
              );
              await page.reload();
              if (app === "Vault") {
                const summary = page
                  .locator("summary")
                  .filter({ hasText: "Account & storage" });
                if (!(await summary.evaluate((s) => s.parentElement.open)))
                  await summary.click();
              }
              await button(
                page,
                (provider === "Plug" ? "Authorize " : "Reconnect ") + provider,
              ).click();
              await expect(
                button(page, "Disconnect " + provider),
              ).toBeVisible();
              for (const k of money)
                assert.equal(counts[k] ?? 0, beforeReload[k]);
              row.reconnect = true;
              if (provider === "Plug") {
                // The actual ingress executes before its response is discarded.
                dropMethod =
                  viewport.width === 1280
                    ? "icrc2_approve"
                    : app === "Wiki"
                      ? "purchase_database_cycles"
                      : vaultPurchase;
                const beforeLoss = { ...counts };
                await button(page, "Review payment").click();
                await button(page, "Pay 1 KINIC").click();
                await expect.poll(() => !!dropped).toBe(true);
                const original = await page.evaluate(() => {
                  const keys = Object.keys(localStorage).filter(k=>k.startsWith("kinic.payments.v1:"));
                  if (keys.length !== 1) throw Error("Expected one original durable record before reload");
                  return {key:keys[0], record:JSON.parse(localStorage.getItem(keys[0]))};
                });
                assert.equal(original.record.stage,dropMethod==="icrc2_approve"?"approval-dispatched":"purchase-dispatched");
                assert.equal(original.record.scope.payer.provider, "plug");
                const moneyAtReload = money.reduce((total, method) => total + (counts[method] ?? 0), 0);
                await page.reload({waitUntil:"domcontentloaded"});
                releaseResponse();
                if (app === "Vault") {
                  const summary = page
                    .locator("summary")
                    .filter({ hasText: "Account & storage" });
                  if (!(await summary.evaluate((s) => s.parentElement.open)))
                    await summary.click();
                }
                recoveryRecord = original.record;
                await button(page, "Authorize Plug").click();
                const complete = page.getByText("Payment complete", {exact:true});
                const readMarker = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), original.key);
                let outcome;
                if (dropMethod === vaultPurchase) {
                  await expect(complete).toBeVisible({timeout:20_000});
                  await expect.poll(() => observations.some(read => read.status === "Paid")).toBe(true);
                  const paid = observations.find(read => read.status === "Paid");
                  await expect(page.getByRole("status").filter({hasText:"Reference " + paid.reference + "."}).first()).toBeVisible();
                  await expect.poll(readMarker).toBeNull();
                  outcome = "confirmed-original-vault-purchase";
                } else {
                  const status = button(page, "Check payment status");
                  await expect(status).toBeEnabled({timeout:20_000});
                  const beforeCheck = observations.length;
                  await status.click();
                  await expect.poll(() => observations.length).toBeGreaterThan(beforeCheck);
                  await expect(page.getByText("Payment needs a status check", {exact:true})).toBeVisible();
                  await expect(complete).toHaveCount(0);
                  assert.deepEqual(await readMarker(), original.record);
                  if (app === "Vault") assert.equal(observations.at(-1).status, "Quoted");
                  if (dropMethod === "purchase_database_cycles") {
                    await expect(page.getByText(/Contact the Wiki billing authority.*to review the original payment/)).toBeVisible();
                    outcome = "original-wiki-purchase-requires-review";
                  } else outcome = "original-approval-remains-unresolved";
                }
                await expect(
                  page.getByRole("button", {
                    name: "Pay 1 KINIC",
                    exact: true,
                  }),
                ).toHaveCount(0);
                assert.equal(
                  counts.icrc2_approve - (beforeLoss.icrc2_approve ?? 0),
                  1,
                );
                const purchase =
                  app === "Wiki" ? "purchase_database_cycles" : vaultPurchase;
                assert.equal(
                  (counts[purchase] ?? 0) - (beforeLoss[purchase] ?? 0),
                  dropMethod === purchase ? 1 : 0,
                );
                assert.equal(
                  (counts.quote_purchase ?? 0) -
                    (beforeLoss.quote_purchase ?? 0),
                  app === "Vault" ? 1 : 0,
                );
                const afterReloadMoneyCalls = money.reduce((total, method) => total + (counts[method] ?? 0), 0) - moneyAtReload;
                assert.equal(afterReloadMoneyCalls, 0);
                row.recovery = { ...dropped, original: {id: original.record.id, stage: original.record.stage, scope: original.record.scope},
                  observations, outcome, retainedOriginal: (await readMarker())?.id === original.record.id,
                  afterReloadMoneyCalls };
              } else await button(page, "Disconnect " + provider).click();
            }
          } catch (error) {
            row.error = String(error);
            row.body = (
              await page
                .locator("body")
                .innerText()
                .catch(() => "")
            ).slice(-2000);
            row.messages = messages.slice(-6);
            console.error(
              app,
              viewport.width,
              provider,
              row.error,
              row.body,
              row.messages,
            );
          }
          row.after = { ...counts };
          save();
        }
      } catch (error) {
        pageRow.error = String(error);
        pageRow.body = (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(-2200);
        pageRow.messages = messages.slice(-6);
        console.error(
          app,
          viewport.width,
          pageRow.error,
          pageRow.body,
          pageRow.messages,
        );
      } finally {
        releaseResponse();
        if (observationErrors.length) {
          pageRow.error = "Could not validate the original recovery read";
          pageRow.observationErrors = observationErrors;
        }
        pageRow.requests = { ...counts };
        save();
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  fee(10);
  save();
}
assert.ok(
  rows.every(
    (r) =>
      !r.error &&
      r.providers.length === 3 &&
      r.providers.every((p) => p.paid === 2 && !p.error),
  ),
  "See " + file,
);
console.log("Shared payments verified", file);
