// Current client protocol against real Wasm; only the WebAuthn device is simulated
// by the existing Ed25519 signing fixture. This is not browser/II evidence.
import assert from "node:assert/strict";
import { IncidentClient } from "../../packages/vault-crypto/.tmp-test/incident.mjs";
import { assertion, ok, owner, b, b64, IDL } from "./vault-restore-fixture.mjs";
export async function completeRemainingParent(f, C, parent, replacements) {
  const originalNow = Date.now;
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      credentials: {
        get: async ({ publicKey }) => {
          const p = JSON.parse(
            assertion({ bytes: publicKey.challenge }, f.credential),
          );
          const bytes = (x) =>
            Uint8Array.from(Buffer.from(x, "base64url")).buffer;
          return {
            rawId: bytes(p.id),
            response: {
              authenticatorData: bytes(p.authenticatorData),
              clientDataJSON: bytes(p.clientDataJSON),
              signature: bytes(p.signature),
              userHandle: bytes(p.userHandle),
            },
          };
        },
      },
    },
  });
  const client = new IncidentClient(
    f.actor,
    owner,
    f.canisterId,
    "vault.kinic.xyz",
    true,
  );
  let kit, archive;
  try {
    await f.pic.advanceTime(421_000);
    const replicaNow = await f.pic.getTime();
    Date.now = () => replicaNow;
    const current = ok(await f.actor.incident_status())[0];
    await client.authenticate(
      f.credential.id,
      { Incident: { job: parent.job, vector_digest: current.vector_digest } },
      [C.sourceG],
    );
    await client.prepare(
      C.sourceG.vault,
      async (bytes) => {
        kit = bytes.slice();
      },
      async () => kit.slice(),
    );
    await client.resume(C.sourceG.vault, async () => kit.slice());
    for (let i = 0; i < 20; i++) {
      const t = ok(await f.actor.incident_status())[0].targets[2];
      if (t.coverage[0]?.complete) break;
      await client.wrapNext(C.sourceG.vault);
    }
    assert.ok(
      "Err" in (await f.actor.incident_cutover_digest()),
      "Full saved backup proof is still required",
    );
    await client.saveBackup(
      C.sourceG.vault,
      async (bytes) => {
        archive = bytes.slice();
      },
      async () => archive.slice(),
      async () => kit.slice(),
    );
    const verified = ok(await f.actor.incident_status())[0];
    assert.ok("BackupVerified" in verified.targets[2].phase);
    assert.ok(verified.targets.slice(0, 2).every((t) => "Purged" in t.phase));
    await f.pic.upgradeCanister({
      sender: owner,
      canisterId: f.canisterId,
      wasm: f.wasm,
      arg: IDL.encode([], []),
    });
    const completed = await client.cutover(f.credential.id);
    assert.ok(completed.complete);
    assert.equal(completed.completed_digest[0].length, 32);
    for (const g of replacements)
      assert.deepEqual(ok(await f.actor.get_vault_header(g.vault)).generation, [
        g,
      ]);
    assert.deepEqual(
      ok(await f.actor.get_vault_header(C.sourceG.vault)).generation,
      verified.targets[2].target,
    );
    const scoped = ok(await f.actor.incident_context())[0].credentials.filter(
      (c) => !c.revoked && "Instances" in c.scope,
    );
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].scope.Instances.length, 2);
    await assert.rejects(
      f.fresh({ Normal: null }, [C.sourceG], {
        ...f.credential,
        id: scoped[0].credential,
      }),
      /Unauthorized|Conflict|InvalidProof/,
    );
    console.log(
      "PASS actual mixed parent: A/B terminal child replacements + C saved/full-verified target; upgrade; fresh current-client whole-job UV atomically completes only C, preserves A/B and scoped authority",
    );
  } finally {
    Date.now = originalNow;
    client.destroy();
    kit?.fill(0);
    archive?.fill(0);
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
}
