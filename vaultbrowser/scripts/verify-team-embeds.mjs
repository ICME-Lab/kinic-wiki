// Real local II and certified Vault. Only the ledger and Wiki article store are fixtures.
import assert from "node:assert/strict";
import {
  chromium,
  expect as playwrightExpect,
} from "../../wikibrowser/node_modules/@playwright/test/index.mjs";
import {
  action,
  completeLogin,
  editor,
  loginButton,
} from "./acceptance-ui.mjs";

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
  const readyLogin = loginButton(surface).and(surface.locator("button:enabled"));
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
  const principal = await page
    .getByText(/^Vault principal /)
    .locator("code")
    .textContent();
  return { context, page, credentials, principal };
}
async function assertParentPrivate(page) {
  const parent = await page.locator("html").innerHTML();
  for (const value of [title, body, edited]) assert.ok(!parent.includes(value));
  assert.equal(
    await page.locator("iframe").evaluate((frame) => frame.contentDocument),
    null,
  );
}
try {
  const owner = await identity();
  const member = await identity();
  assert.notEqual(owner.principal, member.principal);
  console.log(
    "PASS two distinct Vault principals from separate real II registrations",
  );

  await action(owner.page, "Get quote");
  await action(owner.page, "Approve and pay this quote");
  await expect(owner.page.getByText("Paid", { exact: true })).toBeVisible();
  await action(owner.page, "Create Vault");
  await owner.page.getByLabel("Document title").fill(title);
  await editor(owner.page).fill(body);
  await action(owner.page, "Save document");
  await owner.page.getByText("Vault members", { exact: true }).click();
  await owner.page.getByLabel("Member Vault principal").fill(member.principal);
  await action(owner.page, "Add member");
  const row = owner.page
    .getByRole("listitem")
    .filter({ hasText: member.principal });
  await expect(row.getByLabel("Member role")).toHaveValue("Viewer");
  await action(member.page, "Refresh Vaults");
  await action(member.page, "Vault 1 · Active · Viewer");
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
  await Promise.all([
    picker.waitForEvent("close"),
    button(picker, title).click(),
  ]);
  const messages = await wiki.evaluate(() => window.vaultMessages);
  const selection = messages.find((m) => m.type === "kinic-vault-selection");
  assert.deepEqual(messages, [
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
  const markdown = "Original draft.\n\n[非公開資料](" + url + ")\n";
  await action(wiki, "Save");
  await expect(button(wiki, "Open private document")).toBeVisible();
  await wiki.reload();
  assert.equal(
    await wiki.evaluate(
      () => JSON.parse(sessionStorage.getItem("fixture-article")).content,
    ),
    markdown,
  );
  await expect(wiki.locator("iframe")).toHaveCount(0);
  assert.deepEqual(requests, []);
  await button(wiki, "Open private document").click();
  await expect(wiki.locator("iframe")).toHaveAttribute("src", url);
  const frame = wiki.frameLocator("iframe");
  const content = frame.getByText(body, { exact: true });
  await restoreOrSignIn(wiki, frame, content, member.credentials);
  await expect(content).toBeVisible();
  assert.ok(requests.includes(url));
  await assertParentPrivate(wiki);
  console.log(
    "PASS actual picker, reference-only Wiki save/reload, click-triggered cross-origin decryption",
  );

  await row.getByLabel("Member role").selectOption("Editor");
  await expect(row.getByLabel("Member role")).toHaveValue("Editor");
  await member.page.bringToFront();
  await action(member.page, "Refresh Vaults");
  await action(member.page, "Vault 1 · Active · Editor");
  await action(member.page, title);
  await editor(member.page).fill(edited);
  await action(member.page, "Save document");
  console.log(
    "PASS promoted member saved new revision through the Vault workspace",
  );
  await wiki.bringToFront();
  await expect(frame.getByText(edited, { exact: true })).toBeVisible();
  await assertParentPrivate(wiki);
  await row.getByRole("button", { name: "Remove member" }).click();
  await expect(row).toHaveCount(0);
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
