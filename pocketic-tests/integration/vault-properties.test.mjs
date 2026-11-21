// Stateful properties and structured boundary fuzzing against a disposable Vault Wasm.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { VaultClient, fixture, lossy, ok, operation, out, owner } from "../helpers/vault-current.mjs";

const encoder = new TextEncoder();
const titleInputs = ["", " ", "日本語", "🔑".repeat(256), "x".repeat(512), "a\nb"];
const stepsPerSeed = 24;
const fuzzCases = 240;
const seeds = process.env.VAULT_PROPERTY_SEED === undefined
  ? [1, 7, 19, 42, 101, 256, 511, 1024, 2027, 4001, 8191, 32771, 65537, 99991, 0x5eed1234, 0xa17e2345]
  : [Number(process.env.VAULT_PROPERTY_SEED)];
assert.ok(seeds.every((seed) => Number.isInteger(seed) && seed > 0 && seed <= 0xffffffff));

function random(seed) {
  let state = seed;
  return (upperBound) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % upperBound;
  };
}

function data(size, next) {
  return Uint8Array.from({ length: size }, () => next(256));
}

async function assertRevision(client, item, expectedBytes) {
  const decoded = await client.read(item.revision);
  try {
    assert.deepEqual(decoded.metadata, item.metadata);
    assert.deepEqual(decoded.plaintext, expectedBytes);
  } finally {
    decoded.plaintext.fill(0);
  }
}

test("Vault Wasm properties and structured fuzzing on local PocketIC", { timeout: 240000 }, async (suite) => {
  const binary = process.env.POCKET_IC_BIN;
  assert.ok(binary, "Set POCKET_IC_BIN to PocketIC 16.1.0");
  assert.equal(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), "pocket-ic-server 16.1.0");
  const f = await fixture();
  const wire = lossy(f.actor);
  const client = new VaultClient({
    actor: wire.actor,
    identity: { getPrincipal: () => owner },
    canister: f.canisterId.toText(),
    local: true,
  });
  try {
    // The synthetic ledger seeds local credit before testing the production Wasm.
    await f.upgrade(resolve(out, "vault_canister.wasm"));
    const header = await client.create();
    console.log(`Local Vault canister ${f.canisterId.toText()} on PocketIC ${f.url}`);
    await client.open(header);
    const dropMutation = (action) =>
      wire.dropNext((method, args) => method === "mutate" && action in args[0].action);

    for (const seed of seeds) {
      await suite.test(`generated revision sequences preserve committed content (seed ${seed})`, async () => {
        const next = random(seed);
        const initial = { kind: "note", title: "Initial" };
        let body = data(next(512), next);
        let head = { metadata: initial, revision: await client.save(initial, body.slice()) };
        const model = [{ ...head, body }];
        for (let step = 0; step < stepsPerSeed; step++) {
          const mode = next(7);
          try {
            if (mode === 0) {
              client.session.lock();
              await client.open(header);
            } else if (mode === 1) {
              const page = await client.history(head.revision);
              assert.ok(page.entries.length > 0);
              assert.deepEqual(
                page.entries.map(({ revision }) => revision),
                model.slice(-page.entries.length).reverse().map((item) => item.revision.revision),
              );
              const old = model.find((item) => item.revision.revision === page.entries.at(-1).revision);
              await assertRevision(client, old, old.body);
            } else if (mode === 6) {
              if (model.length > 1) {
                const stale = model.at(-2);
                await assert.rejects(client.save(stale.metadata, body.slice(), stale), /Conflict/);
              }
            } else {
              const metadata = { kind: "note", title: titleInputs[next(titleInputs.length)] };
              body = mode === 2 ? data(next(4096), next) : body;
              let revision;
              if (mode >= 4) {
                dropMutation("SaveInline");
                await assert.rejects(client.save(metadata, body.slice(), head), /LostResponse/);
                assert.equal(client.hasPendingSave, true);
                if (mode === 4) {
                  revision = await client.resumeSave();
                } else {
                  const status = await client.cancelSave((committed) => { revision = committed; });
                  assert.equal(status.Committed.revision, revision.revision);
                }
              } else {
                revision = await client.save(metadata, body.slice(), head);
              }
              assert.deepEqual(revision.object, head.revision.object);
              assert.equal(revision.revision, head.revision.revision + 1n);
              head = { metadata, revision };
              model.push({ ...head, body });
            }
            assert.equal(client.hasPendingSave, false);
            await assertRevision(client, head, body);
            const items = await client.items();
            assert.deepEqual(items, [head]);
            wire.calls.length = 0;
          } catch (error) {
            throw new Error(`seed ${seed}, step ${step}, mode ${mode}`, { cause: error });
          }
        }
        await client.purgeObject(head.revision);
        assert.deepEqual(await client.items(), []);
      });
      if (client.hasPendingSave) break;
    }

    await suite.test("saved bytes round-trip across inline and chunk boundaries", async () => {
      const next = random(0xbead);
      for (const size of [0, 1, 262143, 262144, 262145, 1048575, 1048576, 1048577, 10485760]) {
        const metadata = { kind: "attachment", title: "日本語", filename: "document.bin", mime: "application/octet-stream" };
        const plaintext = data(size, next);
        const item = { metadata, revision: await client.save(metadata, plaintext.slice()) };
        assert.equal(item.revision.plain_size, BigInt(size));
        assert.equal(item.revision.chunk_hashes.length, Math.max(1, Math.ceil(size / 1048576)));
        await assertRevision(client, item, plaintext);
        await client.purgeObject(item.revision);
        wire.calls.length = 0;
      }
    });

    await suite.test("chunked interruptions preserve the previous head or return the exact committed revision", async () => {
      const next = random(0xcafe);
      const bytes = data(262145, next);
      const original = { kind: "attachment", title: "Original" };
      const head = { metadata: original, revision: await client.save(original, bytes.slice()) };
      const renamed = { ...original, title: "Renamed" };
      const reserved = ok(await f.actor.get_quota(header.id)).reserved;

      dropMutation("PutChunk");
      await assert.rejects(client.save(renamed, bytes.slice(), head), /LostResponse/);
      assert.ok("Pending" in await client.cancelSave(() => assert.fail("Unfinished upload committed")));
      assert.equal(client.hasPendingSave, false);
      assert.equal(ok(await f.actor.get_quota(header.id)).reserved, reserved);
      assert.deepEqual(await client.items(), [head]);

      dropMutation("CommitRevision");
      await assert.rejects(client.save(renamed, bytes.slice(), head), /LostResponse/);
      wire.dropNext((method) => method === "get_manifest");
      await assert.rejects(client.cancelSave(() => assert.fail("Missing manifest was handed to editor")), /LostResponse/);
      assert.equal(client.hasPendingSave, true);
      let revision;
      const status = await client.cancelSave((committed) => { revision = committed; });
      assert.equal(status.Committed.revision, head.revision.revision + 1n);
      assert.equal(revision.revision, status.Committed.revision);
      assert.equal(client.hasPendingSave, false);
      assert.equal(ok(await f.actor.get_quota(header.id)).reserved, reserved);
      await assertRevision(client, { metadata: renamed, revision }, bytes);
      await assertRevision(client, head, bytes);
      await client.purgeObject(revision);
      wire.calls.length = 0;
    });

    await suite.test(`invalid Candid upload boundaries leave heads and reservations unchanged (${fuzzCases} cases)`, async () => {
      const next = random(0x5eed);
      const metadata = { kind: "note", title: "Boundary baseline" };
      const bytes = encoder.encode("committed content");
      const head = { metadata, revision: await client.save(metadata, bytes.slice()) };
      const baseline = wire.calls.findLast(({ name, args }) => name === "mutate" && "SaveInline" in args[0].action).args[0].action.SaveInline;
      const before = ok(await f.actor.get_quota(header.id));
      for (let i = 0; i < fuzzCases; i++) {
        const input = structuredClone(baseline);
        input.request.object = operation();
        input.request.operation = operation();
        const variant = i % 6;
        if (variant === 0) input.request.plain_size = 262145n + BigInt(next(4096));
        if (variant === 1) input.bytes = input.bytes.slice(0, next(input.bytes.length));
        if (variant === 2) input.request.manifest = new Uint8Array();
        if (variant === 3) input.request.chunk_hashes = [data(31, next)];
        if (variant === 4) input.request.chunk_hashes = [];
        if (variant === 5) input.context_hash[next(input.context_hash.length)] ^= 1;
        const result = await f.actor.mutate({ operation: operation(), action: { SaveInline: input } });
        assert.deepEqual(result, { Err: { InvalidInput: null } }, `upload case ${i}, variant ${variant}`);
      }
      const after = ok(await f.actor.get_quota(header.id));
      assert.equal(after.current, before.current);
      assert.equal(after.reserved, before.reserved);
      assert.deepEqual(await client.items(), [head]);
      assert.deepEqual((await client.pendingUploads()).entries, []);
      await assertRevision(client, head, bytes);
    });
  } finally {
    client.destroy();
    await f.close();
  }
});
