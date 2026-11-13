import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  fixture,
  lossy,
  ok,
  err,
  b,
  operation,
  owner,
  other,
  out,
  IDL,
  VaultClient,
  cryptoLib,
} from "../helpers/vault-current.mjs";
const hex = (b) => Buffer.from(b).toString("hex").toUpperCase(),
  encode = (s) => new TextEncoder().encode(s);
const f = await fixture({ wasm: resolve(out, "vault-state.wasm") });
const clients = [];
try {
  const wire = lossy(f.actor),
    client = new VaultClient({
      actor: wire.actor,
      identity: { getPrincipal: () => owner },
      canister: f.canisterId.toText(),
      local: true,
    });
  clients.push(client);
  const header = await client.create();
  await client.open(header);
  const committed = await client.save(
    { kind: "note", title: "upgrade" },
    encode("preserve this content"),
  );
  const pendingPlaintext = cryptoLib.randomBytes(1024 * 1024 + 1);
  wire.dropNext((n, args) => n === "mutate" && "PutChunk" in args[0].action);
  await assert.rejects(
    client.save({ kind: "attachment", title: "pending" }, pendingPlaintext),
    /LostResponse/,
  );
  const pending = (await client.pendingUploads()).entries[0];
  assert.ok(pending);
  const status = ok(await f.actor.get_upload_status(pending.upload)),
    quota = ok(await f.actor.get_quota(header.id));
  assert.ok(quota.reserved > 0n);
  const snapshot = () =>
    f.controls.fixture_read(
      "SELECT json_object('balance',(SELECT balance_cycles FROM accounts WHERE owner='" +
        owner.toText() +
        "'),'reserved',(SELECT sum(reserved) FROM uploads),'operations',(SELECT json_group_array(hex(operation)||':'||hex(result)) FROM operations),'receipts',(SELECT json_group_array(hex(operation)||':'||result) FROM receipts),'cycle_reservations',(SELECT count(*) FROM vault_cycle_reservations))",
    );
  const before = await snapshot();
  await f.upgrade();
  assert.equal(await snapshot(), before);
  assert.deepEqual(ok(await f.actor.get_upload_status(pending.upload)), status);
  assert.equal(ok(await f.actor.get_quota(header.id)).reserved, quota.reserved);
  assert.equal(
    new TextDecoder().decode((await client.read(committed)).plaintext),
    "preserve this content",
  );
  const completed = await client.resumeSave();
  assert.equal(completed.plain_size, BigInt(pendingPlaintext.length));
  client.session.lock();
  await client.open(header);
  assert.deepEqual((await client.read(completed)).plaintext, pendingPlaintext);
  console.log(
    "PASS schema7 same-Wasm upgrade keeps content, pending ciphertext/upload, exact operation receipts, balance and reservations; real client resumes save and decrypts the original pending plaintext after reopening",
  );
  // Max file, max vaults, optimistic conflict and immutable creation binding.
  const bad = {
    vault: header.id,
    object: b(200),
    expected_revision: 0n,
    operation: operation(),
    plain_size: 10485761n,
    manifest: b(1, 64),
    chunk_hashes: [b(2, 32)],
  };
  err(
    await f.actor.mutate({
      operation: operation(),
      action: { BeginRevision: bad },
    }),
    "InvalidInput",
  );
  for (let i = 0; i < 2; i++)
    ok(
      await f.actor.create_vault({ vault: b(180 + i), operation: operation() }),
    );
  err(
    await f.actor.create_vault({ vault: b(182), operation: operation() }),
    "QuotaExceeded",
  );
  err(
    await f.actor.mutate({
      operation: operation(),
      action: {
        DeleteObject: {
          vault: header.id,
          object: committed.object,
          expected_revision: 99n,
        },
      },
    }),
    "Conflict",
  );
  // Synthetic accounting boundary setup; no 100 MiB payload allocation claim.
  const currentQuota = ok(await f.actor.get_quota(header.id));
  const inflation = 100n * 1024n * 1024n - currentQuota.current;
  const row = "WHERE object=x'" + hex(committed.object) + "' AND revision=1";
  await f.controls.fixture_execute(
    "UPDATE revisions SET plain_size=plain_size+" + inflation + " " + row,
  );
  assert.equal(
    ok(await f.actor.get_quota(header.id)).current,
    100n * 1024n * 1024n,
  );
  err(
    await f.actor.mutate({
      operation: operation(),
      action: { BeginRevision: { ...bad, plain_size: 1n } },
    }),
    "QuotaExceeded",
  );
  await f.controls.fixture_execute(
    "UPDATE revisions SET plain_size=plain_size-" + inflation + " " + row,
  );
  // Prepaid PutChunk/Commit completion is separate from zero-credit cleanup:
  // admit a funded upload, then consume unrelated shared logical capacity.
  await f.fundOwner(other);
  const otherActor = f.actorFor(other);
  const otherClient = new VaultClient({
    actor: otherActor,
    identity: { getPrincipal: () => other },
    canister: f.canisterId.toText(),
    local: true,
  });
  clients.push(otherClient);
  const otherHeader = await otherClient.create();
  await otherClient.open(otherHeader);
  const unrelated = await otherClient.save(
    { kind: "note", title: "unrelated capacity" },
    encode("another owner's accounting row"),
  );
  const prepaidPlaintext = cryptoLib.randomBytes(2 * 1024 * 1024 + 1);
  wire.dropNext(
    (name, args) => name === "mutate" && "BeginRevision" in args[0].action,
  );
  await assert.rejects(
    client.save(
      { kind: "attachment", title: "prepaid completion" },
      prepaidPlaintext,
    ),
    /LostResponse/,
  );
  const admitted = wire.calls.at(-1).args[0].action.BeginRevision;
  const pendingBeforeFill = ok(
    await f.actor.get_upload_status(admitted.operation),
  );
  assert.equal(pendingBeforeFill.Pending.received.length, 0);
  const reservedBeforeCompletion = ok(
    await f.actor.get_quota(header.id),
  ).reserved;
  assert.ok(reservedBeforeCompletion > 0n);
  const capacityBeforeFill = ok(await f.actor.global_capacity());
  let unrelatedInflation = 0n;
  const unrelatedRow =
    "WHERE owner=x'" +
    hex(other.toUint8Array()) +
    "' AND object=x'" +
    hex(unrelated.object) +
    "' AND revision=1";
  const fillSharedCapacity = async () => {
    const capacity = ok(await f.actor.global_capacity());
    const extra = capacity.limit - capacity.used;
    assert.ok(extra >= 0n);
    await f.controls.fixture_execute(
      "UPDATE revisions SET charge=charge+" + extra + " " + unrelatedRow,
    );
    unrelatedInflation += extra;
    assert.equal(ok(await f.actor.global_capacity()).used, capacity.limit);
  };
  await fillSharedCapacity();
  assert.ok(
    ok(await f.actor.account_balance()) > 0n,
    "ordinary upload writes require positive credit",
  );
  err(
    await otherActor.mutate({
      operation: operation(),
      action: {
        BeginRevision: {
          vault: otherHeader.id,
          object: b(221),
          expected_revision: 0n,
          operation: operation(),
          plain_size: 1n,
          manifest: b(1, 64),
          chunk_hashes: [b(2, 32)],
        },
      },
    }),
    "QuotaExceeded",
  );
  assert.equal(
    ok(await f.actor.global_capacity()).used,
    capacityBeforeFill.limit,
  );
  const completionStart = wire.calls.length;
  // Successful chunks release unused receipt headroom. Fill that space again
  // before each next chunk and before commit, so all four admission paths
  // must use their prepaid reservation rather than incidental free capacity.
  for (let index = 0; index < 3; index++) {
    wire.dropNext(
      (name, args) =>
        name === "mutate" &&
        "PutChunk" in args[0].action &&
        args[0].action.PutChunk.index === index,
    );
    await assert.rejects(client.resumeSave(), /LostResponse/);
    assert.equal(
      ok(await f.actor.get_upload_status(admitted.operation)).Pending.received
        .length,
      index + 1,
    );
    await fillSharedCapacity();
  }
  assert.ok(ok(await f.actor.account_balance()) > 0n);
  const prepaidRevision = await client.resumeSave();
  const completions = new Map();
  for (const call of wire.calls
    .slice(completionStart)
    .filter(
      (call) =>
        call.name === "mutate" &&
        ("PutChunk" in call.args[0].action ||
          "CommitRevision" in call.args[0].action),
    )) {
    const id = hex(call.args[0].operation);
    if (completions.has(id)) assert.deepEqual(call, completions.get(id));
    else completions.set(id, call);
  }
  const completionCalls = [...completions.values()];
  assert.deepEqual(
    completionCalls.map((call) => Object.keys(call.args[0].action)[0]),
    ["PutChunk", "PutChunk", "PutChunk", "CommitRevision"],
  );
  assert.equal(ok(await f.actor.get_quota(header.id)).reserved, 0n);
  assert.ok(
    ok(await f.actor.global_capacity()).used < capacityBeforeFill.limit,
  );
  assert.deepEqual(
    (await client.read(prepaidRevision)).plaintext,
    prepaidPlaintext,
  );
  const allocationSnapshot = () =>
    f.controls.fixture_read(
      "SELECT json_object('operations',(SELECT count(*) FROM operations),'receipts',(SELECT count(*) FROM receipts),'uploads',(SELECT count(*) FROM uploads),'reserved',(SELECT COALESCE(sum(reserved),0) FROM uploads))",
    );
  const allocationBeforeReplay = await allocationSnapshot();
  const capacityBeforeReplay = ok(await f.actor.global_capacity());
  for (const call of completionCalls)
    assert.deepEqual(await f.actor.mutate(call.args[0]), call.result);
  assert.equal(await allocationSnapshot(), allocationBeforeReplay);
  assert.deepEqual(ok(await f.actor.global_capacity()), capacityBeforeReplay);
  assert.ok(ok(await f.actor.account_balance()) > 0n);
  await f.controls.fixture_execute(
    "UPDATE revisions SET charge=charge-" +
      unrelatedInflation +
      " " +
      unrelatedRow,
  );
  console.log(
    "PASS funded upload completes each of three unsent chunks and commit from full shared capacity, decrypts original bytes, releases reservation and exactly replays completion without new allocation",
  );

  // An admitted, real three-chunk upload is cancellable at zero balance and full shared capacity.
  // Use direct encrypted Begin/Put calls so no successful commit is discarded.
  const payload = cryptoLib.randomBytes(2 * 1024 * 1024 + 1),
    context = {
      canister: f.canisterId.toText(),
      owner: owner.toText(),
      vault: new Uint8Array(header.id),
      nonce: new Uint8Array(header.nonce),
      key_name: header.key_name,
    };
  const { documents } = await import("../helpers/vault-current.mjs");
  const doc = await documents.encryptDocumentV3(
      client.session.root,
      context,
      b(210),
      1n,
      { kind: "attachment", title: "cancel" },
      payload,
    ),
    upload = operation();
  const begin = {
    vault: header.id,
    object: b(210),
    expected_revision: 0n,
    operation: upload,
    plain_size: BigInt(payload.length),
    manifest: doc.manifest,
    chunk_hashes: doc.hashes,
  };
  const send = (action) => f.actor.mutate({ operation: operation(), action });
  ok(await send({ BeginRevision: begin }));
  for (const [index, bytes] of doc.chunks.entries())
    ok(await send({ PutChunk: { upload, index, bytes } }));
  // Inflate one retained revision's accounting charge, never disable an admission guard.
  const capacity = ok(await f.actor.global_capacity());
  await f.controls.fixture_execute(
    "UPDATE revisions SET charge=charge+" +
      (capacity.limit - capacity.used) +
      " WHERE rowid=(SELECT min(rowid) FROM revisions); UPDATE accounts SET balance_cycles=0 WHERE owner='" +
      owner.toText() +
      "';",
  );
  assert.equal(ok(await f.actor.global_capacity()).used, capacity.limit);
  assert.equal(ok(await f.actor.account_balance()), 0n);
  err(
    await otherActor.mutate({
      operation: operation(),
      action: {
        BeginRevision: {
          ...begin,
          vault: otherHeader.id,
          operation: operation(),
          object: b(221),
          plain_size: 1n,
          manifest: b(1, 64),
          chunk_hashes: [b(2, 32)],
        },
      },
    }),
    "QuotaExceeded",
  );
  const job = operation(),
    first = {
      operation: operation(),
      action: { CancelUpload: { vault: header.id, upload, job } },
    };
  const result = ok(await f.actor.mutate(first));
  assert.deepEqual(result, { Progress: false });
  assert.deepEqual(ok(await f.actor.mutate(first)), result);
  err(
    await f.actor.mutate({
      ...first,
      action: { CancelUpload: { vault: header.id, upload, job: operation() } },
    }),
    "Conflict",
  );
  assert.ok(ok(await f.actor.get_quota(header.id)).reserved > 0n);
  let batches = 1,
    done = false;
  while (!done && batches < 8) {
    done = ok(
      await send({ CancelUpload: { vault: header.id, upload, job } }),
    ).Progress;
    batches++;
  }
  assert.equal(done, true);
  assert.ok(batches <= 4);
  assert.equal(ok(await f.actor.get_quota(header.id)).reserved, 0n);
  err(
    await send({ CancelUpload: { vault: header.id, upload, job } }),
    "Conflict",
  );
  assert.deepEqual(ok(await f.actor.mutate(first)), result);
  await f.controls.fixture_execute(
    "UPDATE revisions SET charge=charge-" +
      (capacity.limit - capacity.used) +
      " WHERE rowid=(SELECT min(rowid) FROM revisions);",
  );
  // Purge and whole-vault cleanup retain their zero-credit path as well.
  const purge = {
    operation: operation(),
    action: {
      PurgeObject: {
        vault: header.id,
        object: committed.object,
        expected_revision: committed.revision,
      },
    },
  };
  assert.deepEqual(ok(await f.actor.mutate(purge)), { Done: null });
  assert.deepEqual(ok(await f.actor.mutate(purge)), { Done: null });
  err(await f.actor.get_manifest(header.id, committed.object, 0n), "NotFound");
  const emptyDeletion = {
    operation: operation(),
    action: { DeleteVault: { vault: b(180) } },
  };
  const deletion = ok(await f.actor.mutate(emptyDeletion));
  assert.deepEqual(ok(await f.actor.mutate(emptyDeletion)), deletion);
  if (!deletion.Progress)
    assert.equal(
      ok(await send({ DeleteVault: { vault: b(180) } })).Progress,
      true,
    );
  assert.ok("Deleted" in ok(await f.actor.get_vault_header(b(180))).state);
  let collected = 0;
  for (; collected < 20; collected++) {
    const result = await send({ Collect: null });
    if ("Err" in result) {
      err(result, "NotFound");
      break;
    }
  }
  assert.ok(collected < 20);
  const operationCount = () =>
    f.controls.fixture_read("SELECT CAST(count(*) AS TEXT) FROM operations");
  const noWorkBefore = await operationCount();
  err(await send({ Collect: null }), "NotFound");
  assert.equal(await operationCount(), noWorkBefore);
  assert.equal(ok(await f.actor.account_balance()), 0n);
  console.log(
    "PASS quota/vault/optimistic guards, cross-owner shared-capacity refusal, zero-balance bounded cancel/purge/delete/GC, exact Progress(false) replay, terminal conflict and no-work Collect allocates no receipt",
  );
  // Actual client cancellation after a lost chunk and lost cleanup response.
  await f.controls.fixture_execute(
    "UPDATE accounts SET balance_cycles=2000000000000;",
  );
  wire.dropNext(
    (name, args) => name === "mutate" && "PutChunk" in args[0].action,
  );
  await assert.rejects(
    client.save(
      { kind: "attachment", title: "client cancellation" },
      cryptoLib.randomBytes(1024 * 1024 + 1),
    ),
    /LostResponse/,
  );
  await f.controls.fixture_execute(
    "UPDATE accounts SET balance_cycles=0 WHERE owner='" +
      owner.toText() +
      "';",
  );
  wire.dropNext(
    (name, args) => name === "mutate" && "CancelUpload" in args[0].action,
  );
  await assert.rejects(client.cancelSave(), /LostResponse/);
  await client.cancelSave();
  assert.equal(client.hasPendingSave, false);
  assert.equal(ok(await f.actor.get_quota(header.id)).reserved, 0n);
  console.log(
    "PASS actual client reconciles lost chunk then lost cleanup reply, preserves cancel job and finishes at zero balance",
  );
  // Durable global cursor must pass an idle first owner, reach an expired second owner, wrap and survive reopen.
  const ordered = [owner, other].sort((a, b) =>
      hex(a.toUint8Array()).localeCompare(hex(b.toUint8Array())),
    ),
    idle = ordered[0],
    busy = ordered[1];
  await f.controls.fixture_execute(
    "UPDATE accounts SET balance_cycles=2000000000000;",
  );
  const busyActor = f.actorFor(busy),
    busyHeader = ok(await busyActor.list_vaults())[0],
    expired = operation();
  ok(
    await busyActor.mutate({
      operation: operation(),
      action: {
        BeginRevision: {
          ...begin,
          vault: busyHeader.id,
          operation: expired,
          object: b(230),
          plain_size: 0n,
          manifest: b(1, 64),
          chunk_hashes: [b(2, 32)],
        },
      },
    }),
  );
  await f.controls.fixture_execute(
    "UPDATE uploads SET expires=1; INSERT INTO global_settings(key,value) VALUES('gc-owner','') ON CONFLICT(key) DO UPDATE SET value='';",
  );
  const cursor = () =>
    f.controls.fixture_read(
      "SELECT value FROM global_settings WHERE key='gc-owner'",
    );
  const count = () =>
    f.controls.fixture_read("SELECT CAST(count(*) AS TEXT) FROM uploads");
  const tick = async () => {
    await f.pic.advanceTime(60_001);
    await f.pic.tick(5);
  };
  await tick();
  assert.equal(await cursor(), hex(idle.toUint8Array()));
  assert.equal(await count(), "1");
  await f.upgrade();
  assert.equal(await cursor(), hex(idle.toUint8Array()));
  await tick();
  assert.equal(await cursor(), hex(busy.toUint8Array()));
  assert.equal(await count(), "0");
  await tick();
  assert.equal(await cursor(), "");
  await tick();
  assert.equal(await cursor(), hex(idle.toUint8Array()));
  console.log(
    "PASS real timer GC: no-op owner A advances to expired B, cursor survives upgrade and wraps without starvation",
  );
} finally {
  clients.forEach((c) => c.destroy());
  await f.close();
}
// Each old version is a fresh minimal SQLite sentinel image; a rejected upgrade must leave every stable byte unchanged.
const old = await fixture({ fund: false });
try {
  for (let version = 1; version <= 6; version++) {
    const v = await old.install(
      resolve(out, "vault-old-schema.wasm"),
      IDL.encode([IDL.Nat8], [version]),
    );
    const before = await old.pic.getStableMemory(v.canisterId);
    await assert.rejects(
      old.upgrade(resolve(out, "vault_canister.wasm"), v),
      /Vault initialization failed|Canister trapped|Storage/,
    );
    assert.deepEqual(await old.pic.getStableMemory(v.canisterId), before);
  }
  console.log(
    "PASS schemas1..6 rejected by production Wasm without changing any stable-memory byte",
  );
} finally {
  await old.close();
}
