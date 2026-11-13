import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  out,
  fixture,
  lossy,
  ok,
  err,
  b,
  operation,
  owner,
  other,
  Principal,
  VaultClient,
  cryptoLib,
} from "../helpers/vault-current.mjs";
const f = await fixture();
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
  wire.dropNext((n) => n === "create_vault");
  await assert.rejects(client.create(), /LostResponse/);
  assert.equal((await client.listVaults()).length, 1);
  const header = await client.create();
  const creates = wire.calls.filter((c) => c.name === "create_vault");
  assert.deepEqual(creates[0].args, creates[1].args);
  assert.deepEqual(creates[0].result, creates[1].result);
  err(
    await f.actor.create_vault({ ...creates[0].args[0], vault: b(222) }),
    "Conflict",
  );
  wire.dropNext((n) => n === "derive_vault_key");
  await assert.rejects(client.open(header), /LostResponse/);
  await client.listVaults();
  await client.open(header);
  const keys = wire.calls.filter((c) => c.name === "derive_vault_key");
  assert.deepEqual(keys[0].args, keys[1].args);
  assert.deepEqual(keys[0].result, keys[1].result);
  assert.equal(client.session.root.extractable, false);

  // Verify a fresh real response independently, then reject forged context/transport/ciphertext.
  const transport = cryptoLib.TransportSecretKey.random(),
    request = {
      vault: header.id,
      operation: operation(),
      transport: transport.publicKeyBytes(),
    };
  const reply = ok(await f.actor.derive_vault_key(request));
  const context = {
    canister: f.canisterId.toText(),
    owner: owner.toText(),
    vault: new Uint8Array(header.id),
    nonce: new Uint8Array(header.nonce),
    key_name: header.key_name,
  };
  const normalized = Object.fromEntries(
    Object.entries(reply).map(([k, v]) => [k, new Uint8Array(v)]),
  );
  const root = await cryptoLib.verifiedRoot(
    context,
    new Uint8Array(header.public_key),
    normalized,
    transport,
    true,
  );
  const sealed = await cryptoLib.seal(
    root,
    new TextEncoder().encode("root continuity"),
    b(7),
  );
  assert.equal(
    new TextDecoder().decode(
      await cryptoLib.open(client.session.root, sealed, b(7)),
    ),
    "root continuity",
  );
  for (const changed of [
    { owner: other.toText() },
    { canister: f.fake.canisterId.toText() },
    { vault: b(33) },
    { nonce: b(34, 32) },
    { key_name: "test_key_1" },
  ])
    await assert.rejects(
      cryptoLib.verifiedRoot(
        { ...context, ...changed },
        new Uint8Array(header.public_key),
        normalized,
        transport,
        true,
      ),
    );
  await assert.rejects(
    cryptoLib.verifiedRoot(
      context,
      new Uint8Array(header.public_key),
      normalized,
      cryptoLib.TransportSecretKey.random(),
      true,
    ),
  );
  const corrupt = {
    ...normalized,
    encrypted_key: normalized.encrypted_key.slice(),
  };
  corrupt.encrypted_key[80] ^= 1;
  await assert.rejects(
    cryptoLib.verifiedRoot(
      context,
      new Uint8Array(header.public_key),
      corrupt,
      transport,
      true,
    ),
  );
  err(
    await f.actor.derive_vault_key({
      ...request,
      transport: cryptoLib.TransportSecretKey.random().publicKeyBytes(),
    }),
    "Conflict",
  );
  console.log(
    "PASS actual anchored vetKD/root; exact lost create/key replay; changed-payload conflict; context/transport/ciphertext tampering rejected",
  );
  const encode = (s) => new TextEncoder().encode(s),
    decode = (b) => new TextDecoder().decode(b);
  let note;
  for (const phase of ["BeginRevision", "PutChunk", "CommitRevision"]) {
    wire.dropNext((n, args) => n === "mutate" && phase in args[0].action);
    const plain = encode("private note " + phase);
    await assert.rejects(
      client.save({ kind: "note", title: phase }, plain),
      /LostResponse/,
    );
    assert.equal(client.hasPendingSave, true);
    const lost = wire.calls.at(-1),
      revision = await client.resumeSave();
    const retries = wire.calls.filter(
      (c) =>
        c.name === "mutate" &&
        Buffer.from(c.args[0].operation).equals(
          Buffer.from(lost.args[0].operation),
        ),
    );
    assert.equal(retries.length, 2);
    assert.deepEqual(retries[0], retries[1]);
    assert.equal(
      decode((await client.read(revision)).plaintext),
      decode(plain),
    );
    note = revision;
  }
  const updated = await client.save(
    { kind: "note", title: "updated" },
    encode("second version"),
    { revision: note, metadata: { kind: "note", title: "old" } },
  );
  const history = await client.history(updated);
  assert.equal(history.entries.length, 2);
  assert.equal(
    decode((await client.read(note)).plaintext),
    "private note CommitRevision",
  );
  const credential = await client.save(
    { kind: "credential", title: "credential content" },
    encode(
      JSON.stringify({
        username: "alice",
        password: "secret",
        url: "https://example.invalid",
      }),
    ),
  );
  assert.equal(
    JSON.parse(decode((await client.read(credential)).plaintext)).password,
    "secret",
  );
  const attachment = cryptoLib.randomBytes(2 * 1024 * 1024 + 1),
    before = (
      await f.pic.canisterStatus({ canisterId: f.canisterId, sender: owner })
    ).memorySize;
  const file = await client.save(
    {
      kind: "attachment",
      title: "attachment",
      filename: "bytes.bin",
      mime: "application/octet-stream",
    },
    attachment,
  );
  assert.deepEqual((await client.read(file)).plaintext, attachment);
  assert.ok(
    (await f.pic.canisterStatus({ canisterId: f.canisterId, sender: owner }))
      .memorySize > before,
  );
  assert.ok(
    ok(await f.actor.global_capacity()).used > BigInt(attachment.length),
  );
  const stored = ok(
    await f.actor.get_chunk(header.id, file.object, file.revision, 0),
  );
  assert.notDeepEqual(
    new Uint8Array(stored).subarray(0, 32),
    attachment.subarray(0, 32),
  );
  await client.deleteObject(updated);
  assert.equal(
    (await client.items()).find((i) =>
      Buffer.from(i.revision.object).equals(Buffer.from(updated.object)),
    ).revision.deleted,
    true,
  );
  assert.equal(
    decode((await client.read(note)).plaintext),
    "private note CommitRevision",
  );
  await client.purgeObject(credential);
  err(await f.actor.get_manifest(header.id, credential.object, 0n), "NotFound");
  const original = client.session.root;
  client.session.lock();
  await client.open(header);
  assert.deepEqual(
    await cryptoLib.open(client.session.root, sealed, b(7)),
    encode("root continuity"),
  );
  assert.notEqual(client.session.root, original);
  const second = new VaultClient({
    actor: f.actorFor(owner),
    identity: { getPrincipal: () => owner },
    canister: f.canisterId.toText(),
    local: true,
  });
  clients.push(second);
  await second.open(header);
  assert.deepEqual((await second.read(file)).plaintext, attachment);
  const foreign = f.actorFor(other);
  assert.deepEqual(ok(await foreign.list_vaults()), []);
  err(await foreign.get_vault_header(header.id), "NotFound");
  err(await foreign.get_manifest(header.id, file.object, 0n), "NotFound");
  err(await f.actorFor(Principal.anonymous()).list_vaults(), "Unauthorized");
  // Positive derivation for distinct real owner/canister/vault contexts, followed by failed cross-context decryption.
  await f.fundOwner(other);
  const foreignHeader = ok(
    await foreign.create_vault({ vault: header.id, operation: operation() }),
  );
  const foreignClient = new VaultClient({
    actor: foreign,
    identity: { getPrincipal: () => other },
    canister: f.canisterId.toText(),
    local: true,
  });
  clients.push(foreignClient);
  await foreignClient.open(foreignHeader);
  await assert.rejects(
    cryptoLib.open(foreignClient.session.root, sealed, b(7)),
  );
  const newVault = ok(
    await f.actor.create_vault({ vault: b(88), operation: operation() }),
  );
  await second.open(newVault);
  await assert.rejects(cryptoLib.open(second.session.root, sealed, b(7)));
  const separate = await f.install();
  ok(
    await separate.actor.set_config([
      { key_name: "test_key_1", minimum_cycles: 100_000_000_000n },
    ]),
  );
  await f.fundOwner(owner, 2_000_000_000_000n, separate);
  const separateHeader = ok(
    await separate.actor.create_vault({
      vault: header.id,
      operation: operation(),
    }),
  );
  const separateClient = new VaultClient({
    actor: separate.actor,
    identity: { getPrincipal: () => owner },
    canister: separate.canisterId.toText(),
    local: true,
  });
  clients.push(separateClient);
  await separateClient.open(separateHeader);
  await assert.rejects(
    cryptoLib.open(separateClient.session.root, sealed, b(7)),
  );
  await assert.rejects(
    cryptoLib.verifiedRoot(
      context,
      new Uint8Array(header.public_key),
      normalized,
      transport,
      false,
    ),
  );
  // Synthetic funds remain only test data. Exercise the default production binary
  // after upgrading this fresh owned canister, including actual key verification.
  await f.upgrade(resolve(out, "vault_canister.wasm"));
  client.session.lock();
  await client.open(header);
  assert.deepEqual((await client.read(file)).plaintext, attachment);
  const productionRevision = await client.save(
    { kind: "note", title: "production binary" },
    encode("existing credit remains usable"),
  );
  assert.equal(
    decode((await client.read(productionRevision)).plaintext),
    "existing credit remains usable",
  );
  console.log(
    "PASS funded disposable fixture upgraded to default production Wasm: real vetKD unlock, existing encrypted read and new encrypted save/read",
  );
  console.log(
    "PASS actual client note/credential/attachment encryption, all save-phase lost replies, history/delete/purge, reopen/second client, physical/logical growth, owner/anonymous isolation; real distinct owner/vault/canister/test_key_1 roots cannot decrypt source",
  );
} finally {
  clients.forEach((c) => c.destroy());
  await f.close();
}
