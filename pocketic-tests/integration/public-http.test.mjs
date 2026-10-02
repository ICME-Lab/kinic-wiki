import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
const resolveFrom = createRequire(
  process.env.POCKETIC_TEST_RESOLVE_FROM ?? import.meta.url,
);
const req = createRequire(realpathSync(resolveFrom.resolve("@dfinity/pic")));
const { IDL } = req("@icp-sdk/core/candid");
const { Principal } = req("@icp-sdk/core/principal");
const { Certificate, Cbor, reconstruct, lookup_path, lookupResultToBuffer } =
  req("@icp-sdk/core/agent");
const { PocketIc, PocketIcServer } = req("@dfinity/pic");
import { idlFactory } from "../../packages/vfs-candid/index.ts";
import test from "node:test";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
if (process.env.POCKET_IC_BIN)
  PocketIcServer.getBinPath = () => process.env.POCKET_IC_BIN;
const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(7));
const configType = IDL.Record({
  kinic_ledger_canister_id: IDL.Text,
  billing_authority_id: IDL.Text,
  iap_authority_id: IDL.Opt(IDL.Text),
  cycles_per_kinic: IDL.Nat64,
  min_update_cycles: IDL.Nat64,
  top_up: IDL.Record({
    enabled: IDL.Bool,
    threshold_cycles: IDL.Nat,
    launcher_principal: IDL.Text,
  }),
});
const config = {
  kinic_ledger_canister_id: "aaaaa-aa",
  billing_authority_id: owner.toText(),
  iap_authority_id: [owner.toText()],
  cycles_per_kinic: 1000n,
  min_update_cycles: 1000000n,
  top_up: {
    enabled: false,
    threshold_cycles: 1000000000n,
    launcher_principal: "aaaaa-aa",
  },
};
const arg = IDL.encode([configType], [config]);
const hash = (value) => createHash("sha256").update(value).digest();
function responseHash(response, body) {
  const status = response.status;
  const bytes = [];
  let value = status;
  do {
    const byte = value & 127;
    value >>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  const entries = [
    "content-type",
    "cache-control",
    "ic-certificateexpression",
  ].map((name) => [hash(name), hash(response.headers.get(name))]);
  entries.push([hash(":ic-cert-status"), hash(Buffer.from(bytes))]);
  entries.sort(([a], [b]) => Buffer.compare(a, b));
  return hash(
    Buffer.concat([
      hash(
        Buffer.concat(
          entries.map(([key, value]) => Buffer.concat([key, value])),
        ),
      ),
      hash(body),
    ]),
  );
}
async function verifyProof(
  response,
  body,
  canisterId,
  rootKey,
  expectedPath,
  witnessOverride,
) {
  const header = response.headers.get("ic-certificate");
  const field = (name) =>
    Uint8Array.from(
      Buffer.from(header.match(new RegExp(`${name}=:([^:]+):`))[1], "base64"),
    );
  const certificate = await Certificate.create({
    certificate: field("certificate"),
    rootKey,
    principal: { canisterId },
  });
  const tree = witnessOverride ?? Cbor.decode(field("tree"));
  const certifiedRoot = lookupResultToBuffer(
    certificate.lookup_path([
      "canister",
      canisterId.toUint8Array(),
      "certified_data",
    ]),
  );
  assert.deepEqual(
    Buffer.from(await reconstruct(tree)),
    Buffer.from(certifiedRoot),
  );
  const expressionPath = Cbor.decode(field("expr_path"));
  assert.deepEqual(expressionPath, [
    "http_expr",
    ...expectedPath.slice(1).split("/"),
    "<$>",
  ]);
  const leaf = lookupResultToBuffer(
    lookup_path(
      [
        ...expressionPath,
        hash(response.headers.get("ic-certificateexpression")),
        "",
        responseHash(response, body),
      ],
      tree,
    ),
  );
  assert.ok(leaf, "Response body and headers must be in the certified witness");
}
test("public HTTP certification with real Wasm and the complete Miniflare Worker", async () => {
  const server = await PocketIcServer.start();
  const pic = await PocketIc.create(server.getUrl());
  function ok(result) {
    assert.ok(
      "Ok" in result,
      JSON.stringify(result, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    );
    return result.Ok;
  }
  try {
    const { actor, canisterId } = await pic.setupCanister({
      sender: owner,
      idlFactory,
      wasm: root + "/target/wasm32-unknown-unknown/release/vfs_canister.wasm",
      arg,
      cycles: 10000000000000n,
    });
    actor.setPrincipal(owner);
    const created = ok(
      await actor.create_database({ name: "HTTP local fixture" }),
    );
    const id = created.database_id;
    ok(await actor.grant_database_cycles_from_iap({
      database_id: id, provider: "apple_iap", external_payment_id: "local-cpu-main",
      product_id: "test.cycles", purchaser_principal: owner.toText(), amount_cycles: 1_000_000_000_000n,
    }));
    ok(
      await actor.write_node({
        database_id: id,
        path: "/Knowledge/article.md",
        kind: { File: null },
        content: "# Public\nAuthentic body",
        metadata_json: "{}",
        expected_etag: [],
      }),
    );
    const port = await pic.makeLive();
    let origin = `http://127.0.0.1:${port}`;
    const get = async (path) => {
      const r = await fetch(
        origin + path + "?canisterId=" + canisterId.toText(),
      );
      const text = await r.text();
      return { r, text };
    };
    const path = `/api/wiki-seo/${id}/Knowledge/article.md`;
    assert.equal((await get(path)).r.status, 404);
    ok(await actor.grant_database_access(id, "2vxsx-fae", { Reader: null }));
    let first = await get(path);
    assert.equal(first.r.status, 200);
    assert.ok(first.text.includes("Authentic body"));
    let warm = await get(path);
    assert.equal(warm.r.status, 200);
    assert.ok(warm.r.headers.get("ic-certificate"));
    assert.equal(warm.r.headers.get("cache-control"), "no-store");
    const status = Cbor.decode(
      new Uint8Array(
        await (await fetch(`${origin}/api/v2/status`)).arrayBuffer(),
      ),
    );
    await verifyProof(warm.r, warm.text, canisterId, status.root_key, path);
    await assert.rejects(
      verifyProof(
        warm.r,
        `${warm.text}tampered`,
        canisterId,
        status.root_key,
        path,
      ),
    );
    await assert.rejects(
      verifyProof(
        warm.r,
        warm.text,
        Principal.anonymous(),
        status.root_key,
        path,
      ),
    );
    await assert.rejects(
      verifyProof(warm.r, warm.text, canisterId, status.root_key, path, [
        3,
        new Uint8Array([1]),
      ]),
    );
    // The actual replicated timer must not evict unchanged page proofs.
    await pic.stopLive();
    await pic.advanceTime(61_000);
    await pic.tick(5);
    origin = `http://127.0.0.1:${await pic.makeLive()}`;
    const assertWarm = async () => {
      const page = await get(path);
      assert.equal(page.r.status, 200);
      assert.ok(page.r.headers.get("ic-certificate"), "Unchanged article must stay on the certified query path");
      await verifyProof(page.r, page.text, canisterId, status.root_key, path);
    };
    await assertWarm();
    actor.setPrincipal(Principal.anonymous());
    assert.ok("Err" in await actor.write_node({
      database_id: id, path: "/Knowledge/denied.md", kind: { File: null },
      content: "Denied", metadata_json: "{}", expected_etag: [],
    }));
    assert.ok("Err" in await actor.revoke_database_access(id, "2vxsx-fae"));
    actor.setPrincipal(owner);
    await assertWarm();
    const other = ok(await actor.create_database({ name: "Other database" }));
    ok(await actor.grant_database_cycles_from_iap({
      database_id: other.database_id, provider: "apple_iap", external_payment_id: "local-cpu-test",
      product_id: "test.cycles", purchaser_principal: owner.toText(), amount_cycles: 1_000_000_000_000n,
    }));
    ok(await actor.rename_database({ database_id: other.database_id, name: "Other renamed" }));
    await assertWarm();
    console.log("PASS: real 60-second timer, denied writes and other-DB edits preserve certification");

    for (let i = 0; i < 100; i++) {
      ok(await actor.write_node({
        database_id: id, path: `/Knowledge/${String(i).padStart(3, "0")}-${"長".repeat(240)}.md`,
        kind: { File: null }, content: "Child", metadata_json: "{}", expected_etag: [],
      }));
    }
    const folderPath = `/api/wiki-seo/${id}/Knowledge`;
    const largeFolder = await get(folderPath);
    assert.equal(largeFolder.r.status, 200);
    assert.ok(Buffer.byteLength(largeFolder.text) <= 128_000);
    const folder = JSON.parse(largeFolder.text);
    assert.equal(folder.childrenTruncated, true);
    assert.ok(folder.children.length > 0 && folder.children.length < 100);
    for (const child of folder.children) assert.ok(ok(await actor.read_node(id, child.path))[0]);
    const folderWarm = await get(folderPath);
    await verifyProof(folderWarm.r, folderWarm.text, canisterId, status.root_key, folderPath);

    const workerReq = createRequire(
      realpathSync(root + "/wikibrowser/node_modules/wrangler/package.json"),
    );
    const { Miniflare } = workerReq("miniflare");
    const mf = new Miniflare({
      modules: true,
      scriptPath: root + "/wikibrowser/dist/server/index.js",
      modulesRules: [
        { type: "ESModule", include: ["**/*.js"], fallthrough: true },
      ],
      compatibilityDate: "2026-07-15",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      cf: false,
      outboundService: async (request) => {
        const url = new URL(request.url);
        assert.equal(url.hostname, "6emaw-iyaaa-aaaay-aacka-cai.icp0.io");
        assert.ok(
          url.pathname.startsWith("/api/wiki-seo/"),
          "No ICP query subrequests",
        );
        return fetch(
          origin + url.pathname + "?canisterId=" + canisterId.toText(),
        );
      },
    });
    try {
      const folderResponse = await mf.dispatchFetch("https://wiki.kinic.xyz/db/" + id + "/Knowledge");
      assert.equal(folderResponse.status, 200);
      const folderHtml = await folderResponse.text();
      assert.ok(folderHtml.includes("wiki-seo-document"));
      assert.ok(folderHtml.includes("Open this folder in the Wiki browser"));
      for (const concurrency of [1, 5])
        for (let batch = 0; batch < 20 / concurrency; batch++) {
          await Promise.all(
            Array.from({ length: concurrency }, async () => {
              const response = await mf.dispatchFetch(
                "https://wiki.kinic.xyz/db/" + id + "/Knowledge/article.md",
              );
              const html = await response.text();
              assert.equal(response.status, 200);
              assert.equal(response.headers.get("cache-control"), "no-store");
              assert.ok(html.includes("wiki-seo-document"));
              assert.ok(html.includes("Authentic body"));
            }),
          );
        }
    } finally {
      await mf.dispose();
    }
    console.log(
      "PASS: 40 full Worker requests through the real local verifying gateway",
    );
    ok(
      await actor.write_node({
        database_id: id,
        path: "/Knowledge/article.md",
        kind: { File: null },
        content: "# Changed\nCurrent body",
        metadata_json: "{}",
        expected_etag: [
          ok(await actor.read_node(id, "/Knowledge/article.md"))[0].etag,
        ],
      }),
    );
    let changed = await get(path);
    assert.equal(changed.r.status, 200);
    assert.ok(changed.text.includes("Current body"));
    assert.ok(!changed.text.includes("Authentic body"));
    await pic.upgradeCanister({
      sender: owner,
      canisterId,
      wasm: root + "/target/wasm32-unknown-unknown/release/vfs_canister.wasm",
      arg: IDL.encode([], []),
    });
    let upgraded = await get(path);
    assert.equal(upgraded.r.status, 200);
    assert.ok(upgraded.text.includes("Current body"));
    ok(await actor.revoke_database_access(id, "2vxsx-fae"));
    assert.equal((await get(path)).r.status, 404);
    assert.equal((await get(path)).r.status, 404);
    ok(await actor.grant_database_access(id, "2vxsx-fae", { Reader: null }));
    assert.equal((await get(path)).r.status, 200);
    const deleted = await pic.updateCall({
      canisterId, sender: owner, method: "delete_account", arg: IDL.encode([], []),
    });
    ok(IDL.decode([IDL.Variant({ Ok: IDL.Null, Err: IDL.Text })], deleted)[0]);
    assert.equal((await get(path)).r.status, 404);
    console.log(
      "PASS: real Wasm gateway cold/warm certification, bounded folder, write, upgrade, revocation and account deletion",
    );
  } finally {
    await pic.tearDown();
    await server.stop();
  }
});
