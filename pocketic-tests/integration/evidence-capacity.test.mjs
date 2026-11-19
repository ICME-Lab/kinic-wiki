// Real pinned-VFS Wasm: legacy main -> upgrade -> bounded copy/verify -> controlled activation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { idlFactory } from "../../packages/vfs-candid/index.ts";
const req = createRequire(realpathSync(createRequire(import.meta.url).resolve("@dfinity/pic")));
const { IDL } = req("@icp-sdk/core/candid");
const { Principal } = req("@icp-sdk/core/principal");
const { PocketIc, PocketIcServer } = req("@dfinity/pic");
if (process.env.POCKET_IC_BIN) PocketIcServer.getBinPath = () => process.env.POCKET_IC_BIN;
const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(71));
const writer = Principal.selfAuthenticating(new Uint8Array(32).fill(72));
const wasm = resolve(import.meta.dirname, "../../target/wasm32-unknown-unknown/release/vfs_canister.wasm");
const baseline = resolve(import.meta.dirname, process.env.KINIC_EVIDENCE_BASELINE_WASM || "../../target/evidence-capacity-baseline.wasm");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const stringify = (value) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v);
const ok = (r) => { assert.ok("Ok" in r, stringify(r)); return r.Ok; };
const control = (s) => ({ database_id: s.database_id, migration_id: s.migration_id, expected_state_hash: s.state_hash });
const configType = IDL.Record({ kinic_ledger_canister_id: IDL.Text, billing_authority_id: IDL.Text,
  iap_authority_id: IDL.Opt(IDL.Text), cycles_per_kinic: IDL.Nat64, min_update_cycles: IDL.Nat64,
  top_up: IDL.Record({ enabled: IDL.Bool, threshold_cycles: IDL.Nat, launcher_principal: IDL.Text }) });
const config = { kinic_ledger_canister_id: "aaaaa-aa", billing_authority_id: owner.toText(), iap_authority_id: [owner.toText()],
  cycles_per_kinic: 1000n, min_update_cycles: 1000000n, top_up: { enabled: false, threshold_cycles: 1000000000n, launcher_principal: "aaaaa-aa" } };
const file = (path, content, kind = "File", metadata = {}) => ({ path, content, kind: { [kind]: null },
  metadata_json: JSON.stringify(metadata), expected_etag: [] });

test("rebuild_keeps_bytes_through_upgrade_and_message_interruptions", { timeout: 300000 }, async (t) => {
  assert.ok(existsSync(baseline), "Build the immutable evidence-capacity baseline before this test");
  const server = await PocketIcServer.start();
  const pic = await PocketIc.create(server.getUrl());
  try {
    const { actor, canisterId } = await pic.setupCanister({ sender: owner, controllers: [owner], idlFactory,
      wasm: baseline, arg: IDL.encode([configType], [config]), cycles: 30000000000000n });
    actor.setPrincipal(owner);
    const database_id = ok(await actor.create_database({ name: "Synthetic capacity fixture" })).database_id;
    ok(await actor.grant_database_cycles_from_iap({ database_id, provider: "apple_iap", external_payment_id: "capacity-fixture",
      product_id: "test.cycles", purchaser_principal: owner.toText(), amount_cycles: 2000000000000n }));
    ok(await actor.grant_database_access(database_id, writer.toText(), { Writer: null }));
    const run = "capacity-synthetic-run";
    const parents = ["/Sources/learning-runs", `/Sources/learning-runs/${sha(run)}`];
    for (const path of parents) ok(await actor.mkdir_node({ database_id, path }));
    const originals = new Map();
    const nodes = [];
    for (let n = 0; n < 20; n++) {
      const id = `tool-${n}`;
      const path = `${parents[1]}/${sha(id)}.json`;
      const record = { text: "uniqueEvidenceNeedle " + "x".repeat(20000) };
      const body = JSON.stringify({ id, run_id: run, kind: "hook", payload: { capture: {
        event: "PostToolUse", tool_name: "CapacityTool", session_evidence: { records: [record, record] } } } });
      originals.set(path, body); nodes.push(file(path, body, "Source", { kind: "kinic.learning.evidence" }));
    }
    nodes.push(file("/Knowledge/protected.md", "approved decision proof", "File", { protected: true, approved_decision: true }));
    ok(await actor.write_nodes({ database_id, nodes }));
    const published = ok(await actor.publish_node({ database_id, path: "/Knowledge/protected.md" }));
    const golden = new Map();
    for (const path of [...originals.keys(), "/Knowledge/protected.md"]) {
      const revision = ok(await actor.current_node_revision({ database_id, path }))[0];
      golden.set(path, { revision, history: ok(await actor.node_history({ database_id, node_id: revision.node_id, before_revision: [], limit: 100 })) });
    }
    await pic.upgradeCanister({ sender: owner, canisterId, wasm, arg: IDL.encode([], []) });
    const stableBefore = (await pic.getStableMemory(canisterId)).byteLength;
    let idle = ok(await actor.evidence_rebuild_status({ database_id }));
    assert.equal(idle.phase, "Idle");
    const beginRequest = { database_id, expected_source_mount: idle.source_mount, expected_schema: idle.source_schema };
    let state = ok(await actor.evidence_rebuild_begin(beginRequest));
    assert.deepEqual(ok(await actor.evidence_rebuild_begin(beginRequest)), state);
    const observedSteps = [];
    async function complete(s, injectUpgrade) {
      let upgraded = false;
      for (let attempt = 0; attempt < 1000; attempt++) {
        if (s.phase === "Ready") return s;
        const request = { database_id, migration_id: s.migration_id, expected_step: s.step, max_rows: 3, max_bytes: 65536 };
        const before = await pic.getCyclesBalance(canisterId);
        const started = performance.now();
        const method = s.phase === "Copying" ? "evidence_rebuild_step" : "evidence_rebuild_verify";
        const next = ok(await actor[method](request));
        const after = await pic.getCyclesBalance(canisterId);
        observedSteps.push({ phase: s.phase, elapsed_ms: performance.now() - started, observed_canister_cycle_delta: before - after, instructions: null });
        // An unknown response is retried with the identical request and returns the same receipt.
        assert.deepEqual(ok(await actor[method](request)), next);
        s = next;
        if (injectUpgrade && !upgraded && s.phase === "Copying") {
          await pic.stopCanister({ canisterId, sender: owner });
          await pic.startCanister({ canisterId, sender: owner });
          await pic.upgradeCanister({ sender: owner, canisterId, wasm, arg: IDL.encode([], []) });
          assert.deepEqual(ok(await actor.evidence_rebuild_status({ database_id })), s); upgraded = true;
        }
      }
      assert.fail("bounded rebuild failed to complete");
    }
    await t.test("controller_gate_and_post_resume_rollback_rules", async () => {
      actor.setPrincipal(writer);
      assert.match((await actor.evidence_rebuild_status({ database_id })).Err, /controller/);
      assert.match((await actor.evidence_rebuild_begin(beginRequest)).Err, /controller/);
      const rejected = await actor.write_node({ database_id, ...file("/Knowledge/blocked.md", "must not commit") });
      assert.ok("Err" in rejected); assert.match(rejected.Err.message, /maintenance/);
      actor.setPrincipal(owner);
      assert.equal(ok(await actor.read_public_node(published.public_id))[0].content, "approved decision proof");
      const stale = control(state);
      state = await complete(state, true);
      assert.ok("Err" in await actor.evidence_rebuild_activate(stale));
      let activated = ok(await actor.evidence_rebuild_activate(control(state)));
      assert.equal(activated.phase, "ActivatedReadOnly");
      const retiredMount = activated.target_mount;
      const rolled = ok(await actor.evidence_rebuild_rollback(control(activated)));
      assert.equal(rolled.phase, "Aborted");
      assert.equal(ok(await actor.read_node(database_id, "/Knowledge/protected.md"))[0].content, "approved decision proof");
      // The next rebuild allocates another permanent slot, never the aborted target's slot.
      state = await complete(ok(await actor.evidence_rebuild_begin(beginRequest)), false);
      assert.notEqual(state.target_mount, retiredMount);
      activated = ok(await actor.evidence_rebuild_activate(control(state)));
      await pic.upgradeCanister({ sender: owner, canisterId, wasm, arg: IDL.encode([], []) });
      assert.equal(ok(await actor.evidence_rebuild_status({ database_id })).phase, "ActivatedReadOnly");
      const active = ok(await actor.evidence_rebuild_resume_writes(control(activated)));
      assert.equal(active.phase, "Active");
      ok(await actor.write_node({ database_id, ...file("/Knowledge/new.md", "afterresumeproof") }));
      assert.ok("Err" in await actor.evidence_rebuild_rollback(control(active)));
      assert.equal(ok(await actor.read_node(database_id, "/Knowledge/new.md"))[0].content, "afterresumeproof");
      for (const [path, expected] of golden) {
        assert.deepEqual(ok(await actor.current_node_revision({ database_id, path }))[0], expected.revision);
        assert.deepEqual(ok(await actor.node_history({ database_id, node_id: expected.revision.node_id, before_revision: [], limit: 100 })), expected.history);
      }
      assert.equal(ok(await actor.read_public_node(published.public_id))[0].content, "approved decision proof");
      const capability = ok(await actor.memory_manifest({ database_id })).capabilities;
      assert.ok(capability.some((c) => c.name === "learning_evidence_storage_v1"));
      const search = (query_text, prefix) => actor.search_nodes({ database_id, query_text, prefix, top_k: 10, preview_mode: [] });
      assert.deepEqual(ok(await search("uniqueEvidenceNeedle", ["/Sources"])), []);
      assert.ok(ok(await search("CapacityTool", ["/Sources"])).length > 0);
      assert.equal(ok(await search("afterresumeproof", ["/Knowledge"]))[0].path, "/Knowledge/new.md");
    });
    await t.test("duplicate_evidence_reduces_logical_pages_without_claiming_stable_shrink", async () => {
      const stableAfter = (await pic.getStableMemory(canisterId)).byteLength;
      assert.equal(state.phase,"Ready");
      assert.equal(state.verified,true);
      assert.ok(state.target_logical_bytes>0n);
      assert.ok(state.target_logical_bytes <= state.source_logical_bytes / 2n);
      assert.ok(stableAfter >= stableBefore);
      const measurement = { fixture: "20 synthetic legacy tool snapshots; includes rollback and a second allocation",
        source_logical_bytes: state.source_logical_bytes, target_logical_bytes: state.target_logical_bytes,
        retained_source_logical_bytes: state.retained_old_logical_bytes, stable_before_bytes: stableBefore, stable_after_bytes: stableAfter,
        current_original_bytes: [...originals.values()].reduce((n, body) => n + Buffer.byteLength(body), 0),
        history_original_bytes: [...golden.values()].reduce((n, entry) => n + entry.history.revisions.reduce((m, r) => m + Buffer.byteLength(r.node.content), 0), 0),
        blob_bytes: null, fts_bytes: null, page_size: null, instructions: null, steps: observedSteps };
      console.log("capacity_wasm_measurement: " + stringify(measurement));
    });
  } finally { await pic.tearDown(); await server.stop(); }
});
