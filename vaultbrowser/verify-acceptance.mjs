// Real current UI + local canisters + one actual II provider. No actor or auth stubs.
import assert from "node:assert/strict";
import { chromium } from "../wikibrowser/node_modules/@playwright/test/index.mjs";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Ed25519KeyIdentity } = require("@icp-sdk/core/identity");
const vaultURL =
  process.env.VAULT_ACCEPTANCE_URL ??
  "http://4fbx2-kt777-77775-aaabq-cai.localhost:8034";
const wikiURL = process.env.WIKI_ACCEPTANCE_URL ?? "http://127.0.0.1:3100";
const iiURL =
  process.env.II_ACCEPTANCE_URL ??
  "http://46el7-ql777-77775-aaada-cai.localhost:8034";
for (const url of [vaultURL, wikiURL, iiURL])
  assert.ok(
    ["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
      new URL(url).hostname.endsWith(".localhost"),
    "Local synthetic acceptance only",
  );
const out = new URL("../target/vault-acceptance/browser/", import.meta.url)
  .pathname;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: [
    "--host-resolver-rules=MAP *.localhost 127.0.0.1",
    `--unsafely-treat-insecure-origin-as-secure=${[vaultURL, wikiURL, iiURL].join(",")}`,
  ],
});
const context = await browser.newContext({ acceptDownloads: true });
context.setDefaultTimeout(90000);
let iiCredentials = [];
async function authenticator(page, credentials = []) {
  const cdp = await context.newCDPSession(page);
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
  return { cdp, authenticatorId };
}
async function signIn(page, button, create = false) {
  const popupPromise = page.waitForEvent("popup");
  await button.click();
  const popup = await popupPromise;
  assert.equal(new URL(popup.url()).origin, iiURL);
  const { cdp, authenticatorId } = await authenticator(popup, iiCredentials);
  const choose = popup.getByRole("button", {
    name: "Continue with passkey",
    exact: true,
  });
  const proceed = popup.getByRole("button", { name: "Continue", exact: true });
  await choose.or(proceed).first().waitFor({ timeout: 60000 });
  if (await choose.isVisible()) await choose.click();
  if (create) {
    await popup
      .getByRole("button", { name: "Create new identity", exact: true })
      .click();
    await popup.getByRole("textbox").fill("Vault Acceptance");
    await popup
      .getByRole("button", { name: "Create identity", exact: true })
      .click();
  } else if (
    await popup
      .getByRole("button", { name: "Use existing identity", exact: true })
      .isVisible()
  )
    await popup
      .getByRole("button", { name: "Use existing identity", exact: true })
      .click();
  await popup
    .getByRole("button", { name: "Continue", exact: true })
    .waitFor({ timeout: 60000 });
  iiCredentials = (
    await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  ).credentials;
  assert.ok(
    iiCredentials.length > 0,
    "Actual II WebAuthn credential required; dummy auth must be disabled",
  );
  const closed = popup.waitForEvent("close");
  await popup.getByRole("button", { name: "Continue", exact: true }).click();
  await closed;
}
try {
  const vault = await context.newPage();
  const vaultAuth = await authenticator(vault);
  const idle = async () => {
    await vault
      .getByText("Processing Vault operation…", { exact: true })
      .waitFor({ state: "hidden", timeout: 120000 });
    assert.equal(
      await vault.getByRole("alert").count(),
      0,
      await vault.getByRole("alert").allTextContents(),
    );
  };
  await vault.route(vaultURL + "/__acceptance-readback.mjs", (route) =>
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
  const readback = () =>
    vault.evaluate(
      async ({ canister, host }) => {
        const { readback } = await import("/__acceptance-readback.mjs");
        return readback(canister, host);
      },
      { canister: new URL(vaultURL).hostname.split(".")[0], host: vaultURL },
    );
  const waitForRetainedGrants = async (reason) => {
    const before = await readback(),
      start = Date.now();
    assert.ok(
      before.restore.Ok[0] &&
        !("Active" in before.restore.Ok[0].pipeline[0].phase),
    );
    console.log(
      "WAIT real 421 seconds for prior grant TTL + receipt retention:",
      reason,
    );
    for (let elapsed = 0; elapsed < 421000; ) {
      const step = Math.min(30000, 421000 - elapsed);
      await vault.waitForTimeout(step);
      elapsed += step;
    }
    assert.ok(Date.now() - start >= 421000);
    const login = vault.getByRole("button", {
      name: "Sign in with Internet Identity",
      exact: true,
    });
    await login.waitFor();
    assert.equal(await vault.locator(".cm-content").count(), 0);
    assert.equal(await vault.locator('input[type="file"]').count(), 0);
    assert.equal(
      await vault.evaluate(
        () => window.__detachedVaultEditor?.state.doc.length ?? 0,
      ),
      0,
    );
    await signIn(vault, login);
    await vault.getByText("Vault principal:", { exact: false }).waitFor();
    const after = await readback();
    assert.equal(after.principal, before.principal);
    for (const key of [
      "restore",
      "headers",
      "incident",
      "credentials",
      "payments",
      "capacity",
    ])
      assert.deepEqual(
        after[key],
        before[key],
        `${key} must survive natural idle logout/retention without new authority or data loss`,
      );
    assert.ok(
      BigInt(after.balance.Ok) > 0n &&
        BigInt(after.balance.Ok) <= BigInt(before.balance.Ok),
      "No new credit; only ordinary storage/execution charges may reduce balance",
    );
    await action("Recover after losing all passkeys");
    console.log(
      "PASS Busy → natural idle logout/private-view cleanup → same-II reauthentication; exact pending state/headers/capacity/payment journal preserved",
      reason,
      "elapsed_ms",
      Date.now() - start,
    );
  };
  const action = async (name) => {
    await vault.getByRole("button", { name, exact: true }).click();
    await idle();
  };
  const download = async (name, path) => {
    const event = vault.waitForEvent("download", { timeout: 120000 });
    await vault.getByRole("button", { name, exact: true }).click();
    await (await event).saveAs(path);
  };
  vault.on("dialog", (d) => d.accept());
  await vault.goto(vaultURL);
  await signIn(
    vault,
    vault.getByRole("button", {
      name: "Sign in with Internet Identity",
      exact: true,
    }),
    true,
  );
  await vault.getByText("Vault principal:", { exact: false }).waitFor();
  const vaultPrincipal = (
    await vault.getByText("Vault principal:", { exact: false }).innerText()
  )
    .replace("Vault principal: ", "")
    .trim();
  console.log(
    "PASS actual II sign-in",
    vaultPrincipal,
    "actual passkeys",
    iiCredentials.length,
  );
  await vault.screenshot({ path: out + "authenticated.png", fullPage: true });
  writeFileSync(
    out + "status.json",
    JSON.stringify(
      { vaultPrincipal, actualIIPasskeys: iiCredentials.length },
      null,
      2,
    ) + "\n",
  );
  const wiki = await context.newPage();
  await authenticator(wiki);
  await wiki.goto(wikiURL + "/dashboard");
  await signIn(wiki, wiki.locator("[data-tid=login-button]"));
  await wiki.locator('[aria-label^="Principal "]').waitFor();
  const wikiPrincipal = (
    await wiki.locator('[aria-label^="Principal "]').getAttribute("aria-label")
  ).slice("Principal ".length);
  assert.notEqual(wikiPrincipal, vaultPrincipal);
  console.log(
    "PASS same II passkey/account distinct Wiki and Vault principals",
    wikiPrincipal,
    vaultPrincipal,
  );
  // A malicious Wiki page asks the same II provider for the Vault derivation root.
  const attackPopup = wiki.waitForEvent("popup");
  await wiki.evaluate(
    ({ iiURL, vaultURL, key }) => {
      const popup = window.open(
        iiURL + "/#authorize",
        "vault-derivation-attack",
      );
      window.__vaultAttackResult = null;
      const receive = (event) => {
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
        if (
          event.data.kind === "authorize-client-failure" ||
          event.data.kind === "authorize-client-success"
        )
          window.__vaultAttackResult = event.data.kind;
      };
      window.addEventListener("message", receive);
    },
    {
      iiURL,
      vaultURL,
      key: [...Ed25519KeyIdentity.generate().getPublicKey().toDer()],
    },
  );
  const attack = await attackPopup;
  await attack
    .getByText("Unverified origin", { exact: true })
    .waitFor({ timeout: 60000 });
  assert.notEqual(
    await wiki.evaluate(() => window.__vaultAttackResult),
    "authorize-client-success",
  );
  await attack.close();
  console.log(
    "PASS malicious Wiki-origin Vault derivation request denied by actual II alternative-origins validation",
  );
  await vault.getByRole("button", { name: "Get quote", exact: true }).click();
  await vault
    .getByRole("button", { name: "Approve and pay this quote", exact: true })
    .click();
  await vault.getByText("Paid", { exact: true }).waitFor({ timeout: 60000 });
  await vault
    .getByRole("button", { name: "Create Vault", exact: true })
    .click();
  await vault.getByLabel("New recovery secret").waitFor({ timeout: 60000 });
  const secret = await vault.getByLabel("New recovery secret").innerText();
  const kitDownload = vault.waitForEvent("download");
  await vault
    .getByRole("button", { name: "Download recovery kit", exact: true })
    .click();
  await (await kitDownload).saveAs(out + "source-kit.json");
  await vault.getByLabel("Re-enter saved recovery secret").fill(secret);
  await vault
    .getByRole("button", { name: "Confirm and activate Vault", exact: true })
    .click();
  await vault.getByLabel("Document title").waitFor({ timeout: 60000 });
  await vault
    .getByLabel("Document title")
    .fill("Actual acceptance private note");
  await vault.locator(".cm-content").fill("actual-browser-private-payload");
  await vault
    .getByRole("button", { name: "Save document", exact: true })
    .click();
  await vault
    .getByRole("button", {
      name: "Actual acceptance private note",
      exact: true,
    })
    .waitFor();
  const backupDownload = vault.waitForEvent("download");
  await vault
    .getByRole("button", { name: "Download encrypted backup", exact: true })
    .click();
  await (await backupDownload).saveAs(out + "source.kvault");
  console.log(
    "PASS actual II + browser passkey + vetKD + synthetic ICRC-2 approval/payment + signed creation/write + encrypted backup download",
  );
  const archive = readFileSync(out + "source.kvault");
  const secretFile = out + "offline-secret";
  writeFileSync(
    secretFile,
    JSON.parse(readFileSync(out + "source-kit.json", "utf8")).secret,
    { mode: 0o600 },
  );
  const recovered = out + `offline-${Date.now()}`;
  execFileSync(
    process.execPath,
    [
      "tools/vault-recovery/src/main.mjs",
      "--backup",
      out + "source.kvault",
      "--secret-file",
      secretFile,
      "--output",
      recovered,
    ],
    { stdio: "pipe" },
  );
  assert.ok(
    readdirSync(recovered)
      .filter((name) => name.endsWith(".bin"))
      .some(
        (name) =>
          readFileSync(recovered + "/" + name, "utf8") ===
          "actual-browser-private-payload",
      ),
  );
  console.log(
    "PASS independent offline CLI decrypts the actual browser-produced archive without II, vetKD or network",
  );
  const sourceHeader = JSON.parse(
    archive.subarray(12, 12 + archive.readUInt32BE(8)).toString(),
  ).header;
  const negative = await wiki.evaluate(
    async ({ canister, host, vaultId, idlPath }) => {
      const { AuthClient } = await import(
        "/node_modules/.vite/deps/@icp-sdk_auth_client.js"
      );
      const { Actor, HttpAgent } = await import(
        "/node_modules/.vite/deps/@icp-sdk_core_agent.js"
      );
      const { idlFactory } = await import(idlPath);
      const auth = await AuthClient.create();
      const agent = await HttpAgent.create({
        host,
        identity: auth.getIdentity(),
        shouldFetchRootKey: true,
      });
      const actor = Actor.createActor(idlFactory, {
        agent,
        canisterId: canister,
      });
      const [balance, rows, header, config] = await Promise.all([
        actor.account_balance(),
        actor.list_vaults(),
        actor.get_vault_header(
          Uint8Array.from(
            atob(vaultId.replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0),
          ),
        ),
        actor.set_config([]),
      ]);
      return {
        principal: auth.getIdentity().getPrincipal().toText(),
        balance,
        rows,
        header,
        config,
      };
    },
    {
      canister: new URL(vaultURL).hostname.split(".")[0],
      host: new URL(vaultURL).origin,
      vaultId: sourceHeader.vault,
      idlPath:
        "/@fs/" +
        new URL("../packages/vault-candid/index.js", import.meta.url).pathname,
    },
  );
  assert.equal(negative.principal, wikiPrincipal);
  assert.equal(negative.balance.Ok, 0n);
  assert.ok("Err" in negative.rows || negative.rows.Ok.length === 0);
  assert.ok("Err" in negative.header);
  assert.ok("Err" in negative.config);
  assert.equal(await vault.evaluate(() => window.opener === null), true);
  const sopPopup = context.waitForEvent("page");
  const cross = await wiki.evaluate(async (vaultURL) => {
    const popup = window.open(vaultURL, "vault-sop-test");
    await new Promise((r) => setTimeout(r, 500));
    let blocked = false;
    try {
      void popup.document.body;
    } catch (e) {
      blocked = e.name === "SecurityError";
    }
    popup?.close();
    return blocked;
  }, vaultURL);
  assert.equal(cross, true);
  await (await sopPopup).close();
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
  console.log(
    "PASS actual browser refuses Wiki framing of Vault under frame-ancestors CSP",
  );

  assert.equal(
    await vault.evaluate(() =>
      JSON.stringify([localStorage, sessionStorage]).includes(
        "actual-browser-private-payload",
      ),
    ),
    false,
  );
  console.log(
    "PASS actual Wiki delegation has zero Vault credit, no Vault list/header/config authority; cross-origin DOM blocked and no Vault opener or plaintext Web Storage",
  );

  if (process.env.VAULT_ACCEPTANCE_CORE_ONLY !== "1") {
    await action("I saved the backup");
    await vault.getByText("Unlock passkeys", { exact: true }).click();
    const second = await vaultAuth.cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "usb",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: false,
        },
      },
    );
    vaultAuth.cdp.once("WebAuthn.credentialAsserted", async () => {
      await vaultAuth.cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId: vaultAuth.authenticatorId,
        enabled: false,
      });
      await vaultAuth.cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
        authenticatorId: second.authenticatorId,
        enabled: true,
      });
    });
    await action("Add passkey");
    const secondCredential = (
      await vaultAuth.cdp.send("WebAuthn.getCredentials", {
        authenticatorId: second.authenticatorId,
      })
    ).credentials[0];
    await vault
      .getByLabel("Authorizing passkey")
      .selectOption(
        Buffer.from(secondCredential.credentialId, "base64").toString(
          "base64url",
        ),
      );
    await vault.evaluate(() => {
      const content = document.querySelector(".cm-content");
      window.__detachedVaultEditor = content.cmTile.root.view;
    });
    await action("Respond to a compromised passkey");
    assert.deepEqual(
      await vault.evaluate(() => ({
        doc: window.__detachedVaultEditor.state.doc.length,
        dom: window.__detachedVaultEditor.contentDOM.textContent,
        destroyed: window.__detachedVaultEditor.destroyed,
      })),
      { doc: 0, dom: "", destroyed: true },
    );
    console.log(
      "PASS actual current editor lock wipes the detached document/DOM and destroys its view",
    );

    await vault.getByLabel("Passkey 1 · all Vaults").check();
    if (
      !(await vault
        .getByRole("button", {
          name: "Revoke and freeze all affected Vaults",
          exact: true,
        })
        .isEnabled())
    ) {
      await vault.getByLabel("Passkey 1 · all Vaults").uncheck();
      await vault.getByLabel("Passkey 2 · all Vaults").check();
    }
    await action("Revoke and freeze all affected Vaults");
    await action("Allocate new target 1");
    console.log(
      "PASS actual incident allocation with fresh existing-job IncidentPrepare proof",
    );
    await download("Save and verify new kit 1", out + "incident-kit.json");
    await vault
      .getByLabel("Reselect saved new kit for target 1")
      .setInputFiles(out + "incident-kit.json");
    await idle();
    await vault
      .getByRole("button", { name: "Resume and prepare target 1", exact: true })
      .click();
    await vault
      .getByLabel("Reselect saved new kit for target 1")
      .setInputFiles(out + "incident-kit.json");
    await idle();
    await download("Save and verify new backup 1", out + "incident.kvault");
    await vault
      .getByLabel("Reselect saved new kit for target 1")
      .setInputFiles(out + "incident-kit.json");
    await vault
      .getByLabel("Reselect saved new backup for target 1")
      .setInputFiles(out + "incident.kvault");
    await idle();
    await action("Commit all verified targets with fresh passkey proof");
    await vault
      .getByText(
        "All incident targets committed. Unlock again with fresh passkey verification.",
        { exact: true },
      )
      .waitFor();
    console.log(
      "PASS actual current incident UI: revoked key, real saved/reselected new kit/archive, full verification, fresh proof atomic cutover",
    );

    // Recovery uses a third physical test device, without any surviving unlock key.
    await vaultAuth.cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
      authenticatorId: second.authenticatorId,
      enabled: false,
    });
    const third = await vaultAuth.cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "usb",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await action("Recover after losing all passkeys");
    const sourceFiles = async () => {
      await vault
        .getByLabel("Select source encrypted backup", { exact: true })
        .setInputFiles(out + "incident.kvault");
      await vault
        .getByLabel("Select original source recovery kit", { exact: true })
        .setInputFiles(out + "incident-kit.json");
    };
    const withSource = async (name) => {
      await vault.getByRole("button", { name, exact: true }).click();
      await sourceFiles();
    };
    await withSource("Select source backup and recovery kit");
    await idle();
    await withSource("Allocate fresh restoration target");
    await idle();
    const reachAuthorizationCapacity = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        await withSource(
          "Resume restoration with source files and fresh proof",
        );
        await vault
          .getByText("Processing Vault operation…", { exact: true })
          .waitFor({ state: "hidden", timeout: 120000 });
        const alerts = await vault.getByRole("alert").allTextContents();
        if (
          alerts.some((text) => text.includes("temporary authorization limit"))
        ) {
          console.log(
            "PASS actual finite authorization capacity refuses additional fresh proof",
          );
          return;
        }
        assert.deepEqual(alerts, []);
      }
      throw Error("Expected actual bounded authorization capacity refusal");
    };
    await reachAuthorizationCapacity();
    await waitForRetainedGrants(
      "completed incident and admitted restore authorization boundary",
    );
    const newKit = vault.waitForEvent("download");
    await withSource("Save new kit and prepared encrypted backup");
    await (await newKit).saveAs(out + "restore-kit.json");
    const prepared = vault.waitForEvent("download");
    await vault
      .getByLabel("Reselect saved restoration NEW kit", { exact: true })
      .setInputFiles(out + "restore-kit.json");
    await (await prepared).saveAs(out + "restored.kvault");
    await vault
      .getByLabel("Reselect saved prepared TARGET backup", { exact: true })
      .setInputFiles(out + "restored.kvault");
    await idle();
    // A fixed-compatible upgrade interrupts the prepared restore. Saved files and fresh
    // WebAuthn proof resume it; this does not claim downgrade compatibility.
    if (process.env.VAULT_ACCEPTANCE_PROJECT) {
      const id = process.env.VAULT_ACCEPTANCE_IDENTITY;
      execFileSync(
        "icp",
        [
          "canister",
          "install",
          "vault",
          "-e",
          "acceptance",
          "--project-root-override",
          process.env.VAULT_ACCEPTANCE_PROJECT,
          "--mode",
          "upgrade",
          "--wasm",
          process.env.VAULT_ACCEPTANCE_WASM,
          "--args-format",
          "hex",
          "--args",
          "4449444c0000",
          ...(id ? ["--identity", id] : []),
        ],
        { stdio: "inherit" },
      );
      await action("Lock Vault");
      await reachAuthorizationCapacity();
      await waitForRetainedGrants(
        "compatible upgrade interrupted a prepared restore",
      );
      console.log(
        "PASS actual canister upgraded with a prepared current-UI restore pending; browser locked before fresh resume",
      );
    }
    await withSource("Permanently discard current live content");
    await idle();
    await withSource("Import saved prepared target");
    await vault
      .getByLabel("Select saved prepared TARGET backup", { exact: true })
      .setInputFiles(out + "restored.kvault");
    await vault
      .getByLabel("Select saved restoration NEW kit", { exact: true })
      .setInputFiles(out + "restore-kit.json");
    await idle();
    await withSource(
      "Verify saved target backup against restored server content",
    );
    await vault
      .getByLabel("Select saved restoration NEW kit", { exact: true })
      .setInputFiles(out + "restore-kit.json");
    await vault
      .getByLabel(
        "Reselect saved prepared TARGET backup for final server comparison",
        { exact: true },
      )
      .setInputFiles(out + "restored.kvault");
    await idle();
    await withSource("Activate verified scoped restoration");
    await idle();
    await vault
      .getByText("Restoration complete for this scoped instance.", {
        exact: false,
      })
      .waitFor();
    console.log(
      "PASS actual current restore UI: original proof, new device, saved/reselected kit/archive, bounded discard/import, server verification and scoped activation",
    );
    const thirdCredential = (
      await vaultAuth.cdp.send("WebAuthn.getCredentials", {
        authenticatorId: third.authenticatorId,
      })
    ).credentials[0];
    await vault
      .getByLabel("Authorizing passkey")
      .selectOption(
        Buffer.from(thirdCredential.credentialId, "base64").toString(
          "base64url",
        ),
      );
    await action("Create a new empty Vault with scoped access");
    await vault
      .getByLabel("Authorizing restored Vault")
      .selectOption({ index: 1 });
    await action("Authorize new empty Vault");
    await action("Allocate empty Vault");
    await download("Save and verify empty Vault kit", out + "empty-kit.json");
    await vault
      .getByLabel("Reselect saved empty Vault kit", { exact: true })
      .setInputFiles(out + "empty-kit.json");
    await idle();
    await action("Activate new empty Vault");
    console.log(
      "PASS actual current scoped-creation UI: fresh proof, new empty instance, saved kit, activation",
    );
  }
} catch (e) {
  for (const [i, p] of context.pages().entries()) {
    console.error(
      "PAGE",
      i,
      p.url(),
      await p
        .getByRole("button")
        .allTextContents()
        .catch(() => []),
      "ALERTS",
      await p
        .getByRole("alert")
        .allTextContents()
        .catch(() => []),
    );
    await p
      .screenshot({ path: out + `failure-${i}.png`, fullPage: true })
      .catch(() => {});
  }
  throw e;
} finally {
  await context.close();
  await browser.close();
}
