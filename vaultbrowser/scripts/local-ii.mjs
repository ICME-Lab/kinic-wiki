import assert from "node:assert/strict";
export async function completeLocalLogin(
  iiURL,
  popup,
  credentials,
  create = false,
) {
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
