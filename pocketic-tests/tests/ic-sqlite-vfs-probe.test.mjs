import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { IDL } from "@dfinity/candid";
import { PocketIc, PocketIcServer } from "@dfinity/pic";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const wasmPath = resolve(
  repoRoot,
  "target/wasm32-unknown-unknown/release/ic_sqlite_vfs_probe.wasm",
);

const resultUnit = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
const resultText = IDL.Variant({ Ok: IDL.Text, Err: IDL.Text });
const resultOptText = IDL.Variant({ Ok: IDL.Opt(IDL.Text), Err: IDL.Text });
const resultNat64 = IDL.Variant({ Ok: IDL.Nat64, Err: IDL.Text });

const idlFactory = ({ IDL }) =>
  IDL.Service({
    put_value: IDL.Func([IDL.Nat8, IDL.Text, IDL.Text], [resultUnit], []),
    get_value: IDL.Func([IDL.Nat8, IDL.Text], [resultOptText], ["query"]),
    update_get_value: IDL.Func([IDL.Nat8, IDL.Text], [resultOptText], []),
    put_then_fail: IDL.Func([IDL.Nat8, IDL.Text, IDL.Text], [resultUnit], []),
    integrity_check: IDL.Func([IDL.Nat8], [resultText], ["query"]),
    checksum: IDL.Func([IDL.Nat8], [resultNat64], ["query"]),
    refresh_checksum: IDL.Func([IDL.Nat8], [resultNat64], []),
  });

async function withProbe(testBody) {
  assert.equal(existsSync(wasmPath), true, `missing wasm at ${wasmPath}`);
  const server = await PocketIcServer.start();
  const pic = await PocketIc.create(server.getUrl());
  try {
    const fixture = await pic.setupCanister({ idlFactory, wasm: wasmPath });
    await testBody({ pic, actor: fixture.actor, canisterId: fixture.canisterId });
  } finally {
    await pic.tearDown();
    await server.stop();
  }
}

function ok(result) {
  assert.deepEqual(Object.keys(result), ["Ok"], String(Object.keys(result)));
  return result.Ok;
}

function err(result) {
  assert.deepEqual(Object.keys(result), ["Err"], String(Object.keys(result)));
  return result.Err;
}

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function sampleText(next, index) {
  const corpus = [
    "",
    " ",
    "shared-key",
    "日本語キー",
    "emoji-🙂",
    "quote-'\"-%_",
    "nul-\0-inside",
    "line\nbreak",
    "slash/path/../x",
    "x".repeat(512),
  ];
  if (index % 3 !== 0) {
    return corpus[next() % corpus.length];
  }

  const length = next() % 48;
  let text = "";
  for (let i = 0; i < length; i += 1) {
    const code = 32 + (next() % 95);
    text += String.fromCharCode(code);
  }
  return text;
}

async function assertModel(actor, model) {
  for (const [slot, values] of model.entries()) {
    assert.equal(ok(await actor.integrity_check(slot)), "ok");
    for (const [key, value] of values.entries()) {
      assert.deepEqual(ok(await actor.get_value(slot, key)), [value]);
      assert.deepEqual(ok(await actor.update_get_value(slot, key)), [value]);
    }
  }
}

test("ic-sqlite-vfs canister keeps slots isolated and query-readable", async () => {
  await withProbe(async ({ actor }) => {
    ok(await actor.put_value(0, "shared-key", "slot-zero"));
    ok(await actor.put_value(1, "shared-key", "slot-one"));

    assert.deepEqual(ok(await actor.get_value(0, "shared-key")), ["slot-zero"]);
    assert.deepEqual(ok(await actor.get_value(1, "shared-key")), ["slot-one"]);
    assert.deepEqual(ok(await actor.update_get_value(0, "shared-key")), ["slot-zero"]);
    assert.equal(ok(await actor.integrity_check(0)), "ok");
    assert.equal(ok(await actor.integrity_check(1)), "ok");
  });
});

test("ic-sqlite-vfs canister rolls back failed update transactions", async () => {
  await withProbe(async ({ actor }) => {
    const message = err(await actor.put_then_fail(0, "rollback-key", "transient"));
    assert.match(message, /missing_table/);
    assert.deepEqual(ok(await actor.get_value(0, "rollback-key")), []);
  });
});

test("ic-sqlite-vfs canister preserves stable memory across upgrade", async () => {
  await withProbe(async ({ pic, actor, canisterId }) => {
    ok(await actor.put_value(0, "persist-key", "before-upgrade"));
    ok(await actor.refresh_checksum(0));
    const checksumBefore = ok(await actor.checksum(0));

    await pic.upgradeCanister({ canisterId, wasm: wasmPath });
    const upgraded = pic.createActor(idlFactory, canisterId);

    assert.deepEqual(ok(await upgraded.get_value(0, "persist-key")), ["before-upgrade"]);
    assert.equal(ok(await upgraded.integrity_check(0)), "ok");
    assert.equal(ok(await upgraded.checksum(0)), checksumBefore);
  });
});

test("ic-sqlite-vfs canister rejects unknown slots without touching known slots", async () => {
  await withProbe(async ({ actor }) => {
    ok(await actor.put_value(0, "known", "kept"));

    assert.match(err(await actor.put_value(2, "known", "bad")), /unknown slot: 2/);
    assert.match(err(await actor.get_value(2, "known")), /unknown slot: 2/);
    assert.deepEqual(ok(await actor.get_value(0, "known")), ["kept"]);
  });
});

test("ic-sqlite-vfs canister survives randomized writes, rollbacks, and upgrades", async () => {
  await withProbe(async ({ pic, actor: initialActor, canisterId }) => {
    const next = rng(0x1c5_017e);
    const model = [new Map(), new Map()];
    let actor = initialActor;

    for (let index = 0; index < 72; index += 1) {
      const slot = next() % 2;
      const key = sampleText(next, index);
      const value = `${sampleText(next, index + 17)}:${index}`;
      const action = next() % 10;

      if (action < 6) {
        ok(await actor.put_value(slot, key, value));
        model[slot].set(key, value);
        assert.deepEqual(ok(await actor.get_value(slot, key)), [value]);
      } else if (action < 8) {
        const before = model[slot].get(key);
        assert.match(err(await actor.put_then_fail(slot, key, value)), /missing_table/);
        assert.deepEqual(ok(await actor.get_value(slot, key)), before === undefined ? [] : [before]);
      } else {
        const checksums = [
          ok(await actor.refresh_checksum(0)),
          ok(await actor.refresh_checksum(1)),
        ];
        await pic.upgradeCanister({ canisterId, wasm: wasmPath });
        actor = pic.createActor(idlFactory, canisterId);
        assert.equal(ok(await actor.checksum(0)), checksums[0]);
        assert.equal(ok(await actor.checksum(1)), checksums[1]);
        await assertModel(actor, model);
      }
    }

    await assertModel(actor, model);
  });
});
