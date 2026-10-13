import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { idlFactory } from "../../packages/vfs-candid/index.ts";
const req = createRequire(realpathSync(createRequire(import.meta.url).resolve("@dfinity/pic")));
const { IDL } = req("@icp-sdk/core/candid");
const { Principal } = req("@icp-sdk/core/principal");
const { PocketIc, PocketIcServer } = req("@dfinity/pic");
if (process.env.POCKET_IC_BIN) PocketIcServer.getBinPath = () => process.env.POCKET_IC_BIN;
const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(7));
const reader = Principal.selfAuthenticating(new Uint8Array(32).fill(8));
const configType = IDL.Record({
  kinic_ledger_canister_id: IDL.Text, billing_authority_id: IDL.Text,
  iap_authority_id: IDL.Opt(IDL.Text), cycles_per_kinic: IDL.Nat64,
  min_update_cycles: IDL.Nat64,
  top_up: IDL.Record({ enabled: IDL.Bool, threshold_cycles: IDL.Nat, launcher_principal: IDL.Text }),
});
const config = {
  kinic_ledger_canister_id: "aaaaa-aa", billing_authority_id: owner.toText(),
  iap_authority_id: [owner.toText()], cycles_per_kinic: 1000n, min_update_cycles: 1000000n,
  top_up: { enabled: false, threshold_cycles: 1000000000n, launcher_principal: "aaaaa-aa" },
};
const ok = (result) => {
  assert.ok("Ok" in result, JSON.stringify(result, (_, value) => typeof value === "bigint" ? String(value) : value));
  return result.Ok;
};
test("real Wasm authorizer protects Reader and public Reader, reused queries, and later writes", async () => {
  const server = await PocketIcServer.start();
  const pic = await PocketIc.create(server.getUrl());
  try {
    const { actor, canisterId } = await pic.setupCanister({ sender: owner, idlFactory,
      wasm: resolve(import.meta.dirname, "../../target/wasm32-unknown-unknown/release/vfs_canister.wasm"),
      arg: IDL.encode([configType], [config]), cycles: 10000000000000n });
    actor.setPrincipal(owner);
    const id = ok(await actor.create_database({ name: "SQL policy fixture" })).database_id;
    ok(await actor.grant_database_cycles_from_iap({ database_id: id, provider: "apple_iap",
      external_payment_id: "local-sql-policy", product_id: "test.cycles",
      purchaser_principal: owner.toText(), amount_cycles: 1000000000000n }));
    const write = (content, expected_etag = []) => actor.write_node({ database_id: id, path: "/policy.md",
      kind: { File: null }, content, metadata_json: "{}", expected_etag });
    const body = "\uFEFF日本語\u0000😀";
    ok(await write(body));
    // The independent npm PocketIC harness retains its original SDK. Verify raw
    // canister bytes here, then exercise the patched product reader below.
    const wire = await pic.queryCall({ canisterId, sender: owner, method: "read_node",
      arg: IDL.encode([IDL.Text, IDL.Text], [id, "/policy.md"]) });
    assert.ok(Buffer.from(wire).includes(Buffer.from(body)));
    const decodedBody = body.slice(1);
    for (const caller of [reader, Principal.anonymous()]) {
      actor.setPrincipal(owner);
      ok(await actor.grant_database_access(id, caller.toText(), { Reader: null }));
      actor.setPrincipal(caller);
      const allowed = "SELECT json_object('path', path) FROM fs_nodes LIMIT 1";
      for (let repeat = 0; repeat < 2; repeat++) {
        assert.equal(ok(await actor.query_database_sql_json(id, allowed, 1)).rows.length, 1);
        assert.equal(ok(await actor.query_database_sql_json(id, "SELECT json_object('ok', 1) FROM fs_nodes LIMIT 1", 1)).rows.length, 1);
        assert.equal(ok(await actor.query_database_sql_json(id, "SELECT json_object('ok', 1) FROM fs_links LIMIT 1", 1)).rows.length, 0);
        for (const sql of [
          'SELECT json_object("from", "fs_nodes", "where", version) FROM schema_migrations LIMIT 1',
          "SELECT json_object('version', version) FROM 'schema_migrations' fs_nodes LIMIT 1",
          "SELECT json_object('version', version) FROM schema_migrations WHERE 'FROM fs_nodes' <> '' LIMIT 1",
          "SELECT json_object('name', name) FROM sqlite_schema fs_nodes LIMIT 1",
          "SELECT json_object('path', path) FROM fs_nodes WHERE path IN schema_migrations LIMIT 1",
          "SELECT json_object('path', path) FROM other.fs_nodes LIMIT 1",
          "SELECT json_object('ok', 1) FROM schema_migrations LIMIT 1",
        ]) assert.ok("Err" in await actor.query_database_sql_json(id, sql, 1), sql);
        assert.equal(ok(await actor.read_node(id, "/policy.md"))[0].content, decodedBody);
      }
      actor.setPrincipal(owner);
      ok(await write(body, [ok(await actor.read_node(id, "/policy.md"))[0].etag]));
      actor.setPrincipal(caller);
      assert.equal(ok(await actor.read_node(id, "/policy.md"))[0].content, decodedBody);
      assert.equal(ok(await actor.query_database_sql_json(id, allowed, 1)).rows.length, 1);
    }
    // Exercise the actual MCP reader with its workspace-patched SDK, through
    // PocketIC's live gateway, rather than the test harness's npm SDK copy.
    const mcpRequire = createRequire(resolve(import.meta.dirname, "../../workers/wiki-mcp/package.json"));
    const { build } = mcpRequire("esbuild");
    const output = resolve(import.meta.dirname, "../../.tmp-preview/pocketic-wiki-node-reader.mjs");
    await build({ entryPoints: [resolve(import.meta.dirname, "../../workers/wiki-mcp/src/vfs.ts")],
      bundle: true, platform: "node", format: "esm", outfile: output,
      banner: { js: "import { createRequire as nodeRequire } from 'node:module'; const require = nodeRequire(import.meta.url);" } });
    const { createNodeReader } = await import(output);
    const port = await pic.makeLive();
    const client = await createNodeReader({ KINIC_WIKI_CANISTER_ID: canisterId.toText(), KINIC_WIKI_IC_HOST: `http://127.0.0.1:${port}` });
    const single = await client.readOne(id, "/policy.md");
    assert.equal(single.content, body);
    const batch = await client.readMany(id, ["/policy.md", "/missing.md", "relative", "/policy.md"]);
    assert.deepEqual(batch[0].node, single);
    assert.deepEqual(batch[3].node, single);
    assert.equal(batch[1].node, null);
    assert.ok(batch[2].error);
    await assert.rejects(client.readMany(id, Array(11).fill("/policy.md")), /1 to 10/);
    await pic.stopLive();
  } finally {
    await pic.tearDown();
    await server.stop();
  }
});


test("Wasm guard reauthorizes prepared statements and clears callbacks within one update", async () => {
  const server = await PocketIcServer.start();
  const pic = await PocketIc.create(server.getUrl());
  try {
    const { actor } = await pic.setupCanister({ sender: owner,
      wasm: resolve(import.meta.dirname, "../../target/wasm32-unknown-unknown/release/ic_sqlite_vfs_probe.wasm"),
      idlFactory: ({ IDL: idl }) => idl.Service({
        verify_read_authorizer: idl.Func([], [idl.Variant({ Ok: idl.Null, Err: idl.Text })], []),
      }), cycles: 10000000000000n });
    ok(await actor.verify_read_authorizer());
    ok(await actor.verify_read_authorizer());
  } finally {
    await pic.tearDown();
    await server.stop();
  }
});
