// Cryptographic response verification, not merely certificate-header presence.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { startVaultPocketIc } from "../helpers/vault-pocketic-server.mjs";
import { idlFactory } from "../../packages/vault-candid/index.js";
const local = createRequire(new URL("../package.json", import.meta.url));
const req = createRequire(realpathSync(local.resolve("@dfinity/pic")));
const { PocketIc, PocketIcServer } = req("@dfinity/pic");
const { HttpAgent } = req("@icp-sdk/core/agent");
const { verifyRequestResponsePair } = createRequire(
  new URL("../../vaultbrowser/package.json", import.meta.url),
)("@dfinity/response-verification");
const root = resolve(import.meta.dirname, "../..");
const server = await startVaultPocketIc(
  process.env.POCKET_IC_BIN ?? PocketIcServer.getBinPath(),
);
let pic;
try {
  pic = await PocketIc.create(server.getUrl(), {
    nns: { state: { type: "new" } },
    application: [{ state: { type: "new" } }],
  });
  await pic.setTime(Date.now());
  const { actor, canisterId } = await pic.setupCanister({
    idlFactory,
    wasm: resolve(root, "target/vault-ii-acceptance/vault_canister.wasm"),
    cycles: 100_000_000_000_000n,
  });
  const port = await pic.makeLive();
  const agent = await HttpAgent.create({
    host: `http://127.0.0.1:${port}`,
    shouldFetchRootKey: true,
  });
  await pic.stopLive();
  const paths = ["/", "/config.json", "/.well-known/ii-alternative-origins"];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const request = {
      url: path,
      method: "GET",
      body: new Uint8Array(),
      headers: [],
      certificate_version: [2],
    };
    const response = await actor.http_request(request);
    const verify = (r, q = request, key = agent.rootKey) =>
      verifyRequestResponsePair(
        q,
        r,
        canisterId.toUint8Array(),
        BigInt(awaitedTime) * 1_000_000n,
        300_000_000_000n,
        key,
        2,
      );
    const awaitedTime = await pic.getTime();
    const certified = verify(response);
    assert.equal(certified.verificationVersion, 2);
    assert.equal(certified.response.statusCode, 200);
    assert.deepEqual(
      new Uint8Array(certified.response.body),
      new Uint8Array(response.body),
    );
    if (path === "/config.json") {
      const config = JSON.parse(new TextDecoder().decode(response.body));
      assert.equal(config.fundingMode, "unavailable");
      assert.equal(config.local, false);
      assert.equal(config.origin, "https://vault.kinic.xyz");
      assert.equal(config.identityProvider, "https://id.ai");
      assert.equal(
        config.derivationOrigin,
        `https://${canisterId.toText()}.icp0.io`,
      );
    }
    const headers = Object.fromEntries(
      response.headers.map(([k, v]) => [k.toLowerCase(), v]),
    );
    assert.equal(headers["x-frame-options"], "DENY");
    assert.equal(headers["cache-control"], "no-store");
    assert.ok(
      headers["content-security-policy"].includes("frame-ancestors 'none'"),
    );
    if (path === "/.well-known/ii-alternative-origins")
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(response.body)).alternativeOrigins,
        ["https://vault.kinic.xyz"],
      );
    const body = new Uint8Array(response.body);
    body[0] ^= 1;
    assert.throws(() => verify({ ...response, body }));
    assert.throws(() =>
      verify({
        ...response,
        headers: response.headers.map(([k, v]) => [
          k,
          k.toLowerCase() === "content-security-policy" ? "default-src *" : v,
        ]),
      }),
    );
    assert.throws(() => verify({ ...response, status_code: 201 }));
    assert.throws(() =>
      verify(response, request, new Uint8Array(agent.rootKey.length)),
    );
    if (path === "/") {
      const html = new TextDecoder().decode(response.body);
      const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
      assert.ok(asset, "Current production JavaScript asset must be served");
      paths.push(asset);
    }
    console.log(
      `PASS certified ${path}: real root/signature/tree/body/status/security headers; tampering denied`,
    );
  }
} finally {
  try {
    await pic?.tearDown();
  } finally {
    await server.stop();
  }
}
