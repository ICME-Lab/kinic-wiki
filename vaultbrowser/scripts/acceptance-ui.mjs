import assert from "node:assert/strict";

export async function completeLogin(popup, credentials, create = false) {
  await popup.waitForURL(process.env.II_ACCEPTANCE_URL + "/**");
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

export const loginButton = (page) =>
  page.getByRole("button", {
    name: "Sign in with Internet Identity",
    exact: true,
  });
export const editor = (page) =>
  page.locator('.cm-content[contenteditable="true"]');
export async function showVaultNavigation(page) {
  const toggle = page.getByRole("button", { name: "Toggle Vault navigation", exact: true });
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await page.getByRole("region", { name: "Vaults", exact: true }).waitFor();
}
export async function settle(page, errors = false) {
  await page
    .getByText("Processing Vault operation…", { exact: true })
    .waitFor({ state: "hidden", timeout: 120000 });
  if (!errors)
    assert.deepEqual(await page.getByRole("alert").allTextContents(), []);
}
export async function action(page, name, errors = false) {
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
