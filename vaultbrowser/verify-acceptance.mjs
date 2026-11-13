// Actual certified UI + real II + actual canisters/crypto. Local fixture only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chromium } from "../wikibrowser/node_modules/@playwright/test/index.mjs";
import { idlFactory } from "../packages/vault-candid/index.js";
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
const out = new URL("../target/vault-ii-acceptance/browser/", import.meta.url)
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
            "../target/vault-browser-readback/readback.mjs",
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
    includeHidden: true,
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
  const lost = [];
  let delayedReady;
  // Execute real ingress, then drop or hold the actual HTTP reply. No fabricated reply.
  await vault.route("**/api/v*/canister/**/call", async (route) => {
    const body = route.request().postDataBuffer();
    const content = body ? Cbor.decode(body).content : undefined;
    const method = content?.method_name;
    let actionName;
    if (method === "mutate")
      actionName = Object.keys(
        IDL.decode(methods.get(method).argTypes, new Uint8Array(content.arg))[0]
          .action,
      )[0];
    if (method === dropMethod && (!dropAction || actionName === dropAction)) {
      await route.fetch();
      lost.push({
        method,
        action: actionName,
        sha256: createHash("sha256").update(content.arg).digest("hex"),
      });
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
  assert.equal(await disclosure.isVisible(), true);
  assert.equal(
    await vault
      .getByText("Account & storage", { exact: true })
      .evaluate((e) => e.parentElement.open),
    false,
  );
  assert.equal(
    await vault
      .getByText("Interrupted uploads", { exact: true })
      .evaluate((e) => e.parentElement.open),
    false,
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
    "actual II login; disclosure and collapsed management; no second Vault factor",
    { principal: owner },
  );
  await action(vault, "Get quote");
  await action(vault, "Approve and pay this quote");
  await vault.getByText("Paid", { exact: true }).waitFor();
  pass("explicit synthetic ledger funding through real ICRC-2 calls");
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
  await vault.reload();
  await vault
    .getByRole("button", { name: "Create Vault", exact: true })
    .waitFor();
  assert.equal(
    await vault.evaluate(
      async () => (await (await fetch("/config.json")).json()).fundingMode,
    ),
    "unavailable",
  );
  await vault.getByText("Account & storage", { exact: true }).click();
  assert.equal(
    await vault
      .getByRole("button", { name: "Get quote", exact: true })
      .isDisabled(),
    true,
  );
  const afterUpgrade = await readback(vault);
  assert.equal(afterUpgrade.principal, owner);
  assert.deepEqual(afterUpgrade.payments, beforeUpgrade.payments);
  assert.ok(
    BigInt(afterUpgrade.balance.Ok) > 0n &&
      BigInt(afterUpgrade.balance.Ok) <= BigInt(beforeUpgrade.balance.Ok),
  );
  pass(
    "fresh owned canister upgraded to default-feature local Wasm; certified funding unavailable, paid journal and prepaid credit retained",
  );

  dropMethod = "create_vault";
  await action(vault, "Create Vault", true);
  await vault
    .getByRole("button", { name: "Retry Vault creation", exact: true })
    .waitFor();
  const first = await readback(vault);
  assert.equal(first.headers.Ok.length, 1);
  await action(vault, "Refresh Vaults");
  assert.equal((await readback(vault)).headers.Ok.length, 1);
  dropMethod = "derive_vault_key";
  await action(vault, "Retry Vault creation", true);
  await vault
    .getByRole("button", { name: "Retry opening Vault", exact: true })
    .waitFor();
  const afterKeyFailure = await readback(vault);
  assert.equal(afterKeyFailure.headers.Ok.length, 1);
  dropMethod = undefined;
  await action(vault, "Retry opening Vault");
  await editor(vault).waitFor();
  for (const method of ["create_vault", "derive_vault_key"]) {
    const replies = lost.filter((x) => x.method === method);
    assert.ok(replies.length > 0);
    assert.equal(new Set(replies.map((x) => x.sha256)).size, 1);
  }
  const vaultId = first.headers.Ok[0].id;
  let sourceName = "Vault 1 · Active";
  pass(
    "lost create reply + Refresh + same create retry + lost key reply retry creates exactly one Vault",
  );
  const title = "Actual II private note",
    plaintext = "actual-browser-private-payload";
  await vault.getByLabel("Document title").fill(title);
  await editor(vault).fill(plaintext);
  dropMethod = "mutate";
  dropAction = "PutChunk";
  await action(vault, "Save document", true);
  await vault
    .getByRole("button", { name: "Resume save", exact: true })
    .waitFor();
  assert.equal(await vault.getByLabel("Document title").isDisabled(), true);
  const chunks = lost.filter((x) => x.action === "PutChunk");
  assert.ok(chunks.length > 0);
  assert.equal(new Set(chunks.map((x) => x.sha256)).size, 1);
  dropMethod = undefined;
  dropAction = undefined;
  await action(vault, "Resume save");
  await action(vault, title);
  assert.equal(await editor(vault).innerText(), plaintext);
  const docs = await inspect(vault, "clientRead", canister, vaultURL, vaultId);
  assert.equal(docs.documents[0].plaintext, plaintext);
  const object = docs.documents[0].object;
  pass(
    "lost real PutChunk replies; frozen editor; exact resume; independent real-client decrypt",
  );
  await action(vault, "New document");
  await vault.getByLabel("Document title").fill("Cancelled upload");
  await editor(vault).fill("cancelled-private-payload");
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
  await action(vault, "Show version history");
  const downloadEvent = vault.waitForEvent("download");
  await action(vault, "Download revision 1");
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
  await assertCleared(vault);
  await action(vault, sourceName);
  await action(vault, title);
  pass("actual private password and File input references clear on close");

  await retain(vault);
  await action(vault, "Create Vault");
  sourceName = `Vault ${(await readback(vault)).headers.Ok.findIndex((h) => h.id.join() === vaultId.join()) + 1} · Active`;
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
  assert.equal(await disclosure.isVisible(), true);
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
    "Vault switch clears prior draft/editor; mobile disclosure/navigation/focus",
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
  await wiki.close();
  pass(
    "same II Wiki principal separation; real II derivation-origin attack denied; SOP/opener/frame CSP",
  );

  // Delay an actual private read, switch context, then deliver its real plaintext-producing reply.
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
    `icp-sdk-${network.host}`,
    `icp-sdk-localhost:${network.port}`,
  ];
  assert.ok(persistence.databases.some((db) => db.name === "auth-client-db"));
  assert.ok(
    persistence.databases.every((db) => allowedDatabases.includes(db.name)),
    "Only SDK authentication and public subnet-key caches may persist",
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
  pass(
    "no Vault plaintext/root/DEK persistence; only SDK auth and public subnet keys; zero Vault WebAuthn calls",
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
    idleExpiry > BigInt(idleStart + 10 * 60 * 1000) * 1000000n,
    "Fresh normal-login signed delegation must outlast the entire idle test",
  );
  console.log(
    "WAIT actual five-minute idle; signed normal delegation expiry",
    idleExpiry.toString(),
  );
  await loginButton(vault).waitFor({ timeout: 330000 });
  assert.ok(Date.now() - idleStart >= 290000);
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
    "natural five-minute idle logout clears retained private UI before signed expiry; retained signer remains valid",
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
