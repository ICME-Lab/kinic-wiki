// Real Wasm and vetKD on PocketIC. Only the owner receives synthetic prepaid credit.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  VaultClient,
  err,
  fixture,
  lossy,
  ok,
  operation,
  other,
  out,
  owner,
} from "../helpers/vault-current.mjs";

const f = await fixture();
const memberActor = f.actorFor(other);
const wire = lossy(memberActor);
function client(actor, principal) {
  return new VaultClient({
    actor,
    identity: { getPrincipal: () => principal },
    canister: f.canisterId.toText(),
    local: true,
  });
}
const author = client(f.actor, owner);
const member = client(wire.actor, other);
const encode = (s) => new TextEncoder().encode(s);
const decode = (bytes) => new TextDecoder().decode(bytes);
const metadata = { kind: "note", title: "Team note" };
try {
  const header = await author.create();
  const vault = Uint8Array.from(header.id);
  await author.open(header);
  const original = await author.save(metadata, encode("Written by owner"));
  await assert.rejects(member.openAccess(vault), /Unauthorized/);
  assert.deepEqual((await member.listAccessibleVaults()).entries, []);

  await author.setMember(other, "Viewer");
  await f.upgrade(resolve(out, "vault_canister.wasm"));
  const [grant] = await author.listMembers();
  assert.equal(grant.principal.toText(), other.toText());
  assert.deepEqual(grant.role, { Viewer: null });
  const ownerBalance = ok(await f.actor.account_balance());
  assert.equal(ok(await memberActor.account_balance()), 0n);
  const [listed] = (await member.listAccessibleVaults()).entries;
  assert.equal(listed.owner.toText(), owner.toText());
  assert.deepEqual(listed.role, grant.role);
  await member.openAccess(vault);
  assert.ok(member.session.root && !member.session.root.extractable);
  assert.equal(
    decode((await member.read(original)).plaintext),
    "Written by owner",
  );
  await assert.rejects(
    member.save(metadata, encode("Viewer write")),
    /Unauthorized/,
  );
  const key = wire.calls.find(
    (call) => call.name === "shared_derive_vault_key",
  );
  assert.ok(key);
  err(await memberActor.get_vault_header(vault), "NotFound");

  assert.ok(ok(await f.actor.account_balance()) < ownerBalance);
  assert.equal(ok(await memberActor.account_balance()), 0n);
  await author.setMember(other, "Editor");
  const [item] = await member.items();
  wire.dropNext(
    (name, args) => name === "shared_mutate" && "SaveInline" in args[1].action,
  );
  await assert.rejects(
    member.save(metadata, encode("Edited by member"), item),
    /LostResponse/,
  );
  const updated = await member.resumeSave();
  const retries = wire.calls.filter(
    (call) =>
      call.name === "shared_mutate" && "SaveInline" in call.args[1].action,
  );
  assert.equal(retries.length, 2);
  assert.deepEqual(retries[0], retries[1]);
  assert.equal(updated.revision, 2n);
  assert.equal(
    decode((await author.read(updated)).plaintext),
    "Edited by member",
  );
  assert.deepEqual(
    (await member.history(updated)).entries.map((r) => r.revision),
    [2n, 1n],
  );

  // A lost Begin reply leaves one real pending upload. Changing role fences its retry.
  wire.dropNext(
    (name, args) =>
      name === "shared_mutate" && "BeginRevision" in args[1].action,
  );
  await assert.rejects(
    member.save(
      {
        kind: "attachment",
        title: "Pending",
        filename: "pending.bin",
        mime: "application/octet-stream",
      },
      new Uint8Array(256 * 1024 + 1),
    ),
    /LostResponse/,
  );
  const begin = wire.calls.findLast((call) => call.name === "shared_mutate");
  const upload = begin.args[1].action.BeginRevision.operation;
  assert.deepEqual(
    ok(await memberActor.shared_list_pending_uploads(vault, [])).entries[0]
      .upload,
    upload,
  );
  await author.setMember(other, "Viewer");
  err(await memberActor.shared_mutate(...retries[0].args), "Unauthorized");
  err(await memberActor.shared_mutate(...begin.args), "Unauthorized");
  await member.openAccess(vault);
  assert.equal(member.hasPendingSave, false);
  assert.equal(
    decode((await member.read(updated)).plaintext),
    "Edited by member",
  );
  assert.ok(member.session.root);

  await author.removeMember(other);
  for (const [name, args] of [
    ["get_vault_access", [vault]],
    ["shared_derive_vault_key", key.args],
    ["shared_derive_vault_key", [{ ...key.args[0], operation: operation() }]],
    ["shared_list_objects", [vault, []]],
    ["shared_get_manifest", [vault, updated.object, updated.revision]],
    ["shared_get_chunk", [vault, updated.object, updated.revision, 0]],
    ["shared_list_history", [vault, updated.object, 0n]],
    ["shared_get_quota", [vault]],
    ["shared_list_pending_uploads", [vault, []]],
    ["shared_get_upload_status", [vault, upload]],
    [
      "shared_get_upload_status",
      [vault, retries[0].args[1].action.SaveInline.request.operation],
    ],
    ["shared_mutate", retries[0].args],
    ["shared_mutate", begin.args],
  ])
    err(await memberActor[name](...args), "Unauthorized");
  await assert.rejects(member.openAccess(vault), /Unauthorized/);
  assert.equal(member.session.root, undefined);
  assert.deepEqual((await member.listAccessibleVaults()).entries, []);
  assert.equal(
    decode((await author.read(updated)).plaintext),
    "Edited by member",
  );
  console.log(
    "PASS shared Wasm viewer, editor, exact retry, downgrade, revocation, cached-root lock and upgrade retention",
  );
} finally {
  member.destroy();
  author.destroy();
  await f.close();
}
