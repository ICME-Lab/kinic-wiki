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
const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(31));
const reader = Principal.selfAuthenticating(new Uint8Array(32).fill(32));
const outsider = Principal.selfAuthenticating(new Uint8Array(32).fill(33));
const wasm = resolve(import.meta.dirname, "../../target/wasm32-unknown-unknown/release/vfs_canister.wasm");
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
const revisionRef = (revision) => ({ path: revision.node.path, node_id: revision.node_id,
  revision: revision.revision, etag: revision.node.etag, content_hash: revision.content_hash });
const item = (path, content, expected_etag = [], metadata = { authority: "agent", kind: "lesson" }) => ({
  path, content, kind: { File: null }, metadata_json: JSON.stringify(metadata), expected_etag,
});
async function fixture(callback, initialWasm = wasm) {
  const server = await PocketIcServer.start();
  const pic = await PocketIc.create(server.getUrl());
  try {
    const { actor, canisterId } = await pic.setupCanister({ sender: owner, idlFactory,
      wasm: initialWasm, arg: IDL.encode([configType], [config]), cycles: 10000000000000n });
    actor.setPrincipal(owner);
    const database_id = ok(await actor.create_database({ name: "Learning revision fixture" })).database_id;
    ok(await actor.grant_database_cycles_from_iap({ database_id, provider: "apple_iap",
      external_payment_id: "local-learning-revisions", product_id: "test.cycles",
      purchaser_principal: owner.toText(), amount_cycles: 1000000000000n }));
    const write = (path, content, expected = [], metadata) => actor.write_node({ database_id, ...item(path, content, expected, metadata) });
    const current = (path) => actor.current_node_revision({ database_id, path });
    const history = (node_id, before_revision = [], limit = 100) => actor.node_history({ database_id, node_id, before_revision, limit });
    await callback({ pic, actor, canisterId, database_id, write, current, history });
  } finally { await pic.tearDown(); await server.stop(); }
}

test("real Wasm preserves revision identity through edits, moves, deletion, recreation and upgrade", async () => {
  await fixture(async ({ pic, actor, canisterId, database_id, write, current, history }) => {
    ok(await write("/source.md", "original"));
    const first = ok(await current("/source.md"))[0];
    assert.equal(first.node.content, "original"); assert.ok(first.revision > 0n);
    assert.match(first.content_hash, /^[a-f0-9]{64}$/);
    ok(await actor.edit_node({ database_id, path: "/source.md", old_text: "original", new_text: "edited",
      replace_all: false, expected_etag: [first.node.etag] }));
    const edited = ok(await current("/source.md"))[0];
    assert.equal(edited.node_id, first.node_id); assert.ok(edited.revision > first.revision);
    assert.equal(edited.node.content, "edited"); assert.notEqual(edited.content_hash, first.content_hash);
    ok(await actor.move_node({ database_id, from_path: "/source.md", to_path: "/moved.md",
      overwrite: false, expected_etag: [edited.node.etag], expected_target_etag: [] }));
    assert.deepEqual(ok(await current("/source.md")), []);
    const moved = ok(await current("/moved.md"))[0];
    assert.equal(moved.node_id, first.node_id);
    ok(await actor.delete_node({ database_id, path: "/moved.md", expected_etag: [moved.node.etag], expected_folder_index_etag: [] }));
    assert.deepEqual(ok(await current("/moved.md")), []);
    const deletedHistory = ok(await history(first.node_id));
    assert.equal(deletedHistory.revisions[0].deleted, true);
    assert.ok(deletedHistory.revisions.some((entry) => entry.node.content === "original" && entry.node.path === "/source.md" && !entry.deleted));
    const page = ok(await history(first.node_id, [], 1));
    assert.equal(page.revisions.length, 1); assert.equal(page.next_cursor.length, 1);
    const older = ok(await history(first.node_id, page.next_cursor, 100));
    assert.ok(older.revisions.every((entry) => entry.revision < page.revisions[0].revision));
    ok(await write("/moved.md", "recreated"));
    const recreated = ok(await current("/moved.md"))[0];
    assert.notEqual(recreated.node_id, first.node_id); assert.ok(recreated.revision > moved.revision);
    await pic.upgradeCanister({ sender: owner, canisterId, wasm, arg: IDL.encode([], []) });
    assert.deepEqual(ok(await current("/moved.md"))[0], recreated);
    assert.deepEqual(ok(await history(first.node_id)), deletedHistory);
  });
});

test("real Wasm atomically guards learning evidence, protects human instructions and replays publication", async () => {
  await fixture(async ({ pic, actor, canisterId, database_id, write, current }) => {
    ok(await write("/evidence.md", "source v1"));
    const source = ok(await current("/evidence.md"))[0];
    const request = { scope_guards: [], database_id, operation_id: "learning-operation-1",
      evidence: [revisionRef(source)], targets: [item("/lesson.md", "conditional lesson")] };
    const published = ok(await actor.publish_learning(request));
    const lesson = ok(await current("/lesson.md"))[0];
    assert.equal(lesson.node.content, "conditional lesson");
    assert.deepEqual(ok(await actor.publish_learning(request)), published);
    assert.deepEqual(ok(await current("/lesson.md"))[0], lesson);
    const mismatched = await actor.publish_learning({ ...request, targets: [item("/lesson.md", "changed")] });
    assert.ok("Err" in mismatched); assert.ok("InvalidOperation" in mismatched.Err.code);
    ok(await write("/evidence.md", "source v2", [source.node.etag]));
    const stale = await actor.publish_learning({ ...request, operation_id: "stale-operation", targets: [item("/must-not-exist.md", "bad")] });
    assert.ok("Err" in stale); assert.ok("EtagConflict" in stale.Err.code);
    assert.deepEqual(ok(await actor.read_node(database_id, "/must-not-exist.md")), []);
    assert.deepEqual(ok(await actor.publish_learning(request)), published);
    const latest = ok(await current("/evidence.md"))[0];
    const atomicFailure = await actor.publish_learning({ scope_guards: [], database_id, operation_id: "atomic-target-failure",
      evidence: [revisionRef(latest)], targets: [item("/rollback.md", "must roll back"),item("/lesson.md", "bad", ["wrong-etag"])] });
    assert.ok("Err" in atomicFailure);
    assert.deepEqual(ok(await actor.read_node(database_id, "/rollback.md")), []);
    assert.equal(ok(await current("/lesson.md"))[0].node.content, "conditional lesson");
    ok(await write("/approved.md", "human decision", [], { authority: "human", approved_decision: true }));
    const protectedNode = ok(await current("/approved.md"))[0];
    for (const target of [item("/approved.md", "overwrite", [protectedNode.node.etag]),item("/AGENTS.md", "new instruction"),item("/new-approved.md", "approved", [], { authority: "agent", approved: true })]) {
      const result = await actor.publish_learning({ scope_guards: [], database_id, operation_id: `protected-${target.path}`, evidence: [revisionRef(latest)], targets: [target] });
      assert.ok("Err" in result); assert.ok("Forbidden" in result.Err.code);
    }
    ok(await actor.grant_database_access(database_id, reader.toText(), { Reader: null }));
    actor.setPrincipal(reader);
    assert.equal(ok(await current("/lesson.md"))[0].node_id, lesson.node_id);
    assert.ok("Err" in await actor.publish_learning({ ...request, operation_id: "reader-attempt" }));
    actor.setPrincipal(outsider);
    assert.ok("Err" in await current("/lesson.md"));
    actor.setPrincipal(owner);
    await pic.upgradeCanister({ sender: owner, canisterId, wasm, arg: IDL.encode([], []) });
    assert.deepEqual(ok(await actor.publish_learning(request)), published);
    assert.deepEqual(ok(await current("/lesson.md"))[0], lesson);
  });
});

test("old-schema real Wasm migrates existing content to an honest baseline revision", {
  skip: !process.env.KINIC_LEARNING_BASELINE_WASM,
}, async () => {
  await fixture(async ({ pic, actor, canisterId, database_id, write, current, history }) => {
    ok(await write("/legacy.md", "legacy first"));
    const legacy = ok(await actor.read_node(database_id, "/legacy.md"))[0];
    ok(await write("/legacy.md", "legacy current", [legacy.etag]));
    const before = ok(await actor.read_node(database_id, "/legacy.md"))[0];
    await pic.upgradeCanister({ sender: owner, canisterId, wasm, arg: IDL.encode([], []) });
    const migrated = ok(await current("/legacy.md"))[0];
    assert.deepEqual(migrated.node, before); assert.ok(migrated.revision > 0n);
    const baseline = ok(await history(migrated.node_id));
    assert.equal(baseline.revisions.length, 1);
    assert.equal(baseline.revisions[0].node.content, "legacy current");
    ok(await write("/legacy.md", "after migration", [migrated.node.etag]));
    const after = ok(await current("/legacy.md"))[0];
    assert.equal(after.node_id, migrated.node_id); assert.ok(after.revision > migrated.revision);
  }, resolve(process.env.KINIC_LEARNING_BASELINE_WASM));
});


test("real Wasm atomically rejects stale retrieval scopes but ignores Sources intent writes", async () => {
  await fixture(async ({ actor, database_id, write, current }) => {
    const scope = async (prefix) => ok(await actor.scope_revision({database_id, prefix}));
    const original = await scope("/Knowledge");
    const request = {database_id, operation_id:"scope-guarded", evidence:[],
      targets:[item("/Knowledge/tested.md","evaluated lesson")],
      scope_guards:[{prefix:"/Knowledge",revision:original}]};
    ok(await write("/Knowledge/new-neighbor.md","changes retrieval"));
    const changed = await scope("/Knowledge");
    assert.ok(changed > original);
    const stale = await actor.publish_learning(request);
    assert.ok("Err" in stale); assert.ok("EtagConflict" in stale.Err.code);
    assert.deepEqual(ok(await current("/Knowledge/tested.md")),[]);
    request.scope_guards[0].revision=changed;
    ok(await write("/Sources/intent.json","own publication intent"));
    assert.equal(await scope("/Knowledge"),changed);
    const published=ok(await actor.publish_learning(request));
    assert.deepEqual(ok(await actor.publish_learning(request)),published);
    const node=ok(await current("/Knowledge/new-neighbor.md"))[0];
    ok(await actor.move_node({database_id,from_path:node.node.path,to_path:"/Sources/moved-neighbor.md",overwrite:false,expected_etag:[node.node.etag],expected_target_etag:[]}));
    assert.ok(await scope("/Knowledge") > changed);
    ok(await actor.grant_database_access(database_id,reader.toText(),{Reader:null}));
    actor.setPrincipal(reader); assert.ok(await scope("/Knowledge") > original);
    actor.setPrincipal(outsider); assert.ok("Err" in await actor.scope_revision({database_id,prefix:"/Knowledge"}));
  });
});
