// Real local II and certified Vault. Only the ledger and Wiki article store are fixtures.
import assert from "node:assert/strict";
import { build } from "vite";
import {
  chromium,
  expect as playwrightExpect,
} from "../../wikibrowser/node_modules/@playwright/test/index.mjs";
import {
  action,
  completeLogin,
  editor,
  loginButton,
  showVaultNavigation,
} from "./acceptance-ui.mjs";
import { assertDeviceKeyStore, readDeviceKeyStore } from "./device-key-store.mjs";

import { createRequire } from "node:module";
const { Cbor } = createRequire(import.meta.url)("@icp-sdk/core/agent");
const methodName = (request) => {
  const data = request.postDataBuffer();
  return data && Cbor.decode(data).content?.method_name;
};
const expect = playwrightExpect.configure({ timeout: 45000 });
const vaultURL = process.env.VAULT_ACCEPTANCE_URL;
const wikiURL = process.env.WIKI_ACCEPTANCE_URL;
for (const value of [vaultURL, wikiURL, process.env.II_ACCEPTANCE_URL]) {
  const url = new URL(value);
  assert.equal(url.origin, value);
  assert.equal(url.protocol, "http:");
  assert.ok(
    url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost"),
  );
}
assert.notEqual(vaultURL, wikiURL);
const title = "Disposable private team document";
const body = "Original team-only content from the owner.";
const edited = "Updated team-only content from the editor.";
const button = (page, name) => page.getByRole("button", { name, exact: true });
// Independent SDK client with its stock IdbStorage, bundled only in this test
// process. Its reads verify the browser's ordinary persisted login contract.
const [sdk] = await build({
  configFile: false,
  logLevel: "error",
  build: {
    write: false,
    lib: {
      entry: createRequire(import.meta.url).resolve("@icp-sdk/auth/client"),
      formats: ["es"],
    },
    rollupOptions: { output: { codeSplitting: false } },
  },
});
assert.ok(sdk.output[0].exports.includes("AuthClient"));
const sdkURL = vaultURL + "/__team-sdk-check.mjs";
async function stockPrincipal(frame) {
  return frame.evaluate(async (url) => {
    const { AuthClient } = await import(url);
    const client = await AuthClient.create({
      idleOptions: { disableIdle: true },
    });
    return (await client.isAuthenticated())
      ? client.getIdentity().getPrincipal().toText()
      : null;
  }, sdkURL);
}
const browser = await chromium.launch({
  args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
});
async function signIn(page, surface = page, credentials = [], create = false) {
  const [popup] = await Promise.all([
    page.context().waitForEvent("page"),
    loginButton(surface).click(),
  ]);
  return completeLogin(popup, credentials, create);
}
// The anonymous sign-in button is mounted disabled during SDK startup. Wait
// for a resolved state before deciding whether the stored delegation is usable.
async function restoreOrSignIn(page, surface, signedIn, credentials) {
  const readyLogin = loginButton(surface).and(
    surface.locator("button:enabled"),
  );
  await expect(signedIn.or(readyLogin)).toBeVisible();
  if (await readyLogin.isVisible()) {
    await signIn(page, surface, credentials);
  }
}
async function identity() {
  const context = await browser.newContext();
  context.setDefaultTimeout(45000);
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(vaultURL);
  const credentials = await signIn(page, page, [], true);
  await action(page, "Account settings");
  await page.locator("summary").filter({ hasText: "Account & storage" }).click();
  const principal = await page
    .getByRole("region", { name: "Vault account", exact: true })
    .locator('dl > dt:text-is("Vault principal") + dd > code')
    .textContent();
  return { context, page, credentials, principal };
}
async function manageMembers(page) {
  await showVaultNavigation(page);
  await button(page, "Actions for Vault 1").click();
  await page.getByRole("menuitem", { name: "Manage members", exact: true }).click();
  await page.getByText("Vault members", { exact: true }).waitFor();
}
async function assertParentPrivate(page) {
  const parent = await page.locator("html").innerHTML();
  for (const value of [title, body, edited]) assert.ok(!parent.includes(value));
  assert.ok(
    await page
      .locator("iframe")
      .evaluateAll((frames) =>
        frames.every((frame) => frame.contentDocument === null),
      ),
  );
}
try {
  const owner = await identity();
  const member = await identity();
  assert.notEqual(owner.principal, member.principal);
  console.log(
    "PASS two distinct Vault principals from separate real II registrations",
  );

  // The first-key subsidy covers the owner. The member's cold key also
  // draws on the owner's account, funded here through the synthetic ledger.
  await action(owner.page, "Review payment");
  await action(owner.page, "Pay 1 KINIC");
  await owner.page.getByText("Payment complete", { exact: true }).waitFor();
  await action(owner.page, "Back to Vault");
  await action(member.page, "Back to Vault");
  await showVaultNavigation(owner.page);
  await action(owner.page, "Create Vault");
  await owner.page.getByLabel("Document title").fill(title);
  await editor(owner.page).fill(body);
  await action(owner.page, "Save document");
  await manageMembers(owner.page);
  await owner.page.getByLabel("Member Vault principal").fill(member.principal);
  await action(owner.page, "Add member");
  const row = owner.page
    .getByRole("listitem")
    .filter({ hasText: member.principal });
  await expect(row.getByLabel("Member role")).toHaveValue("Viewer");
  await action(member.page, "Refresh Vaults");
  await showVaultNavigation(member.page);
  await action(member.page, "Vault 1 · Viewer");
  await action(member.page, title);
  await expect(member.page.getByText(body, { exact: true })).toBeVisible();
  await expect(button(member.page, "Save document")).toHaveCount(0);
  console.log(
    "PASS owner saved encrypted note and granted Viewer through Vault UI",
  );

  const wiki = await member.context.newPage();
  const requests = [];
  wiki.on("request", (request) => {
    if (new URL(request.url()).origin === vaultURL)
      requests.push(request.url());
  });
  await wiki.goto(wikiURL + "/?saved");
  await wiki.evaluate((origin) => {
    window.vaultMessages = [];
    window.addEventListener("message", (event) => {
      if (event.origin === origin) window.vaultMessages.push(event.data);
    });
  }, vaultURL);
  const [picker] = await Promise.all([
    wiki.waitForEvent("popup"),
    button(wiki, "Insert private document").click(),
  ]);
  await picker.waitForURL(vaultURL + "/pick");
  const selectVault = button(picker, "Vault 1 · Viewer");
  await restoreOrSignIn(picker, picker, selectVault, member.credentials);
  await selectVault.click();
  await expect(button(picker, title)).toBeVisible();
  const pickerKeys = await picker.evaluate(readDeviceKeyStore);
  assertDeviceKeyStore(pickerKeys, `${new URL(vaultURL).hostname.split(".")[0]}:${member.principal}`);
  assert.ok(pickerKeys.records.some(record => record.key), "picker must retain only a non-extractable root handle");
  await picker.reload();
  await restoreOrSignIn(picker, picker, selectVault, member.credentials);
  await selectVault.click();
  await expect(button(picker, title)).toBeVisible();
  await Promise.all([
    picker.waitForEvent("close"),
    button(picker, title).click(),
  ]);
  const messages = await wiki.evaluate(() => window.vaultMessages);
  const selection = messages.find((m) => m.type === "kinic-vault-selection");
  assert.deepEqual(messages, [
    { type: "kinic-vault-picker-ready" },
    { type: "kinic-vault-picker-ready" },
    {
      type: "kinic-vault-selection",
      vault: selection?.vault,
      object: selection?.object,
    },
  ]);
  for (const id of [selection.vault, selection.object])
    assert.match(id, /^[a-f0-9]{32}$/);
  const url = vaultURL + "/embed/" + selection.vault + "/" + selection.object;
  const reference = "[非公開資料](" + url + ")";
  const draft = wiki.getByRole("textbox");
  await expect(draft.locator(".cm-line").nth(2)).toHaveText(reference);
  const [secondPicker] = await Promise.all([
    wiki.waitForEvent("popup"),
    button(wiki, "Insert private document").click(),
  ]);
  const secondVault = button(secondPicker, "Vault 1 · Viewer");
  await restoreOrSignIn(
    secondPicker,
    secondPicker,
    secondVault,
    member.credentials,
  );
  await secondVault.click();
  await Promise.all([
    secondPicker.waitForEvent("close"),
    button(secondPicker, title).click(),
  ]);
  await expect(draft.locator(".cm-line").nth(4)).toHaveText(reference);
  const markdown =
    "Original draft.\n\n" + reference + "\n\n" + reference + "\n";
  await action(wiki, "Save");
  await expect(button(wiki, "Open private document")).toHaveCount(2);
  await wiki.reload();
  assert.equal(
    await wiki.evaluate(
      () => JSON.parse(sessionStorage.getItem("fixture-article")).content,
    ),
    markdown,
  );
  await expect(wiki.locator("iframe")).toHaveCount(0);
  assert.deepEqual(requests, []);
  await button(wiki, "Open private document").first().click();
  await expect(wiki.locator("iframe")).toHaveAttribute("src", url);
  const frame = wiki.frameLocator("iframe").first();
  const content = frame.getByText(body, { exact: true });
  await restoreOrSignIn(wiki, frame, content, member.credentials);
  await expect(content).toBeVisible();
  assert.ok(requests.includes(url));
  await assertParentPrivate(wiki);
  console.log(
    "PASS actual picker, reference-only Wiki save/reload, click-triggered cross-origin decryption",
  );

  await button(wiki, "Open private document").click();
  const sibling = wiki.frameLocator("iframe").nth(1);
  await restoreOrSignIn(
    wiki,
    sibling,
    sibling.getByText(body, { exact: true }),
    member.credentials,
  );
  await expect(sibling.getByText(body, { exact: true })).toBeVisible();
  await wiki.route(sdkURL, (route) =>
    route.fulfill({ contentType: "text/javascript", body: sdk.output[0].code }),
  );
  const siblingWindow = await (
    await wiki.locator("iframe").nth(1).elementHandle()
  ).contentFrame();
  const embeddedKeys = await siblingWindow.evaluate(readDeviceKeyStore);
  assertDeviceKeyStore(embeddedKeys, `${new URL(vaultURL).hostname.split(".")[0]}:${member.principal}`);
  assert.ok(embeddedKeys.records.some(record => record.key), "embedded views retain only non-extractable roots");
  let held = false,
    release,
    delivered;
  const resumed = new Promise((resolve) => {
    release = resolve;
  });
  const complete = new Promise((resolve) => {
    delivered = resolve;
  });
  let delayed = false;
  const holdRead = async (route) => {
    if (
      !delayed &&
      route.request().frame() === siblingWindow &&
      methodName(route.request()) === "shared_get_chunk"
    ) {
      delayed = true;
      const response = await route.fetch();
      assert.ok(response.ok());
      held = true;
      await resumed;
      await route.fulfill({ response });
      delivered();
    } else await route.continue();
  };
  await wiki.route("**/api/v*/canister/**/call", holdRead);
  await row.getByLabel("Member role").selectOption("Editor");
  await expect(row.getByLabel("Member role")).toHaveValue("Editor");
  await member.page.bringToFront();
  await action(member.page, "Refresh Vaults");
  await showVaultNavigation(member.page);
  await action(member.page, "Vault 1 · Editor");
  await action(member.page, title);
  await editor(member.page).fill(edited);
  await action(member.page, "Save document");
  console.log(
    "PASS promoted member saved new revision through the Vault workspace",
  );
  await wiki.bringToFront();
  await expect(frame.getByText(edited, { exact: true })).toBeVisible();
  await assertParentPrivate(wiki);
  await expect.poll(() => held).toBe(true);
  await expect(sibling.getByText(body, { exact: true })).toBeVisible();
  await button(frame, "Sign out").click();
  await expect(loginButton(frame)).toBeEnabled();
  await expect(loginButton(sibling)).toBeEnabled();
  const afterLogout = [];
  const observePrivateReads = (request) => {
    if (/\/api\/v\d+\/canister\/.*\/call$/.test(request.url())) {
      const method = methodName(request);
      if (method?.startsWith("shared_") || method === "get_vault_access")
        afterLogout.push(method);
    }
  };
  wiki.on("request", observePrivateReads);
  release();
  await complete;
  await wiki.unroute("**/api/v*/canister/**/call", holdRead);
  for (const privateFrame of [frame, sibling]) {
    await expect(privateFrame.getByText(title, { exact: true })).toHaveCount(0);
    await expect(privateFrame.getByText(body, { exact: true })).toHaveCount(0);
    await expect(privateFrame.getByText(edited, { exact: true })).toHaveCount(
      0,
    );
  }
  await siblingWindow.evaluate(() => window.dispatchEvent(new Event("focus")));
  assert.deepEqual(afterLogout, []);
  wiki.off("request", observePrivateReads);
  await assertParentPrivate(wiki);
  console.log(
    "PASS explicit logout clears both sibling Vault iframes through delivery of a held real chunk reply",
  );
  await signIn(wiki, frame, member.credentials);
  await expect(frame.getByText(edited, { exact: true })).toBeVisible();
  assert.equal(await stockPrincipal(siblingWindow), member.principal);
  const [pendingPopup] = await Promise.all([
    wiki.context().waitForEvent("page"),
    loginButton(sibling).click(),
  ]);
  await pendingPopup.waitForURL(process.env.II_ACCEPTANCE_URL + "/**");
  await button(frame, "Sign out").click();
  await expect(loginButton(sibling)).toBeEnabled();
  await completeLogin(pendingPopup, member.credentials);
  await expect(loginButton(sibling)).toBeEnabled();
  assert.equal(await stockPrincipal(siblingWindow), null);
  // A newly mounted provider also reads the post-logout storage.
  await siblingWindow.goto(url);
  await expect(loginButton(sibling)).toBeEnabled();
  await expect(sibling.getByText(edited, { exact: true })).toHaveCount(0);
  console.log(
    "PASS a pre-logout II popup completion leaves both the stock SDK and a fresh Vault iframe anonymous",
  );
  await signIn(wiki, frame, member.credentials);
  await expect(frame.getByText(edited, { exact: true })).toBeVisible();
  await owner.page.addInitScript(() => {
    window.ownerKeyCacheReads = 0;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (this.transaction.db.name === "kinic-vault-device-keys-v1" && typeof key === "string" && key.startsWith("key:"))
        window.ownerKeyCacheReads++;
      return get.call(this, key);
    };
  });
  let derived = 0;
  const observeOwner = (request) => {
    if (
      /\/api\/v\d+\/canister\/.*\/call$/.test(request.url()) &&
      methodName(request) === "derive_vault_key"
    )
      derived++;
  };
  owner.page.on("request", observeOwner);
  // Clear saved browser keys so reload exercises a cold closed Vault rather
  // than PR #206's automatic reopen from a saved device key.
  await owner.page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("kinic-vault-device-keys-v1");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const names = Array.from(db.objectStoreNames);
    if (names.length) {
      const tx = db.transaction(names, "readwrite");
      for (const name of names) tx.objectStore(name).clear();
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    db.close();
  });
  await owner.page.reload();
  // Reload preserves /vault-settings but drops its in-memory Vault selection.
  await action(owner.page, "Back to Vault");
  await manageMembers(owner.page);
  await expect(owner.page.getByLabel("Document title")).toHaveCount(0);
  const readsBeforeRemove = await owner.page.evaluate(() => window.ownerKeyCacheReads);
  await row.getByRole("button", { name: "Remove member" }).click();
  await expect(row).toHaveCount(0);
  assert.equal(derived, 0);
  assert.equal(
    (await owner.page.evaluate(() => window.ownerKeyCacheReads)) - readsBeforeRemove,
    0,
    "member removal must not fetch even a saved root",
  );
  owner.page.off("request", observeOwner);
  console.log(
    "PASS cold owner removed an Editor from a closed Vault without any key derivation",
  );
  await wiki.bringToFront();
  await expect(
    frame.getByText("This private document is unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(frame.getByText(edited, { exact: true })).toHaveCount(0);
  await expect(frame.getByText(title, { exact: true })).toHaveCount(0);
  await assertParentPrivate(wiki);
  console.log(
    "PASS promoted editor saved revision, iframe observed update and cleared after owner revoked membership",
  );
} finally {
  await browser.close();
}
