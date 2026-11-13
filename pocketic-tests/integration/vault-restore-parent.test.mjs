import assert from "node:assert/strict";
import { join } from "node:path";
import {
  restoreFixture,
  b,
  b64,
  ok,
  owner,
  IDL,
  root,
  cryptoLib,
} from "../helpers/vault-restore-fixture.mjs";
import {
  sourceArchive,
  prepare,
  importAndActivate,
  resume,
  rejectInvalidPreflight,
} from "../helpers/vault-restore-pipeline.mjs";
import {
  addVault,
  fillCredentials,
  startParent,
} from "../helpers/vault-restore-owner.mjs";
const f = await restoreFixture();
try {
  const B = await addVault(f, 2),
    C = await addVault(f, 3);
  const sourceA = await sourceArchive(f),
    sourceB = await sourceArchive(B),
    sourceC = await sourceArchive(C);
  const old = await fillCredentials(f);
  const before = ok(await f.actor.get_vault_header(f.sourceG.vault));
  await assert.rejects(prepare(f, sourceA), /QuotaExceeded/);
  assert.deepEqual(ok(await f.actor.get_vault_header(f.sourceG.vault)), before);
  assert.deepEqual(ok(await f.actor.restore_admission_status()), []);
  const parent = await startParent(
    f,
    [f.sourceG, B.sourceG, C.sourceG],
    old[0],
  );
  const a = await prepare(f, sourceA);
  assert.equal(ok(await f.actor.list_vaults()).length, 3);
  await rejectInvalidPreflight(f, a);
  if (process.env.VAULT_RESTORE_FULL_QUOTA === "1") {
    await f.pic.upgradeCanister({
      sender: owner,
      canisterId: f.canisterId,
      wasm: join(root, "target/vault-restore-quota-baseline.wasm"),
      arg: IDL.encode([], []),
    });
    assert.equal(ok(await f.actor.global_capacity()).used, 209715200n);
    await f.pic.advanceTime(421_000);
    a.grant = await resume(f, a);
  }
  await importAndActivate(f, a);
  assert.equal(ok(await f.actor.list_vaults()).length, 3);
  const afterA = ok(await f.actor.incident_status())[0];
  assert.deepEqual(afterA.targets.slice(1), parent.targets.slice(1));
  assert.ok("Purged" in afterA.targets[0].phase);
  for (const v of [B, C])
    assert.ok(
      "IncidentRequired" in
        ok(await f.actor.get_vault_header(v.sourceG.vault)).state,
    );
  const authorities = ok(await f.actor.incident_context())[0].credentials;
  assert.equal(authorities.filter((c) => !c.revoked).length, 10);
  assert.deepEqual(
    authorities.find((c) => b64(c.credential) === b64(a.candidate.id)).scope,
    { Instances: [{ vault: a.target.vault, nonce: a.target.nonce }] },
  );
  await f.pic.advanceTime(86_821_000);
  ok(await f.actor.list_vaults()); // Runs bounded maintenance through an authorized owner read.
  for (const v of [B, C])
    assert.ok(
      "IncidentRequired" in
        ok(await f.actor.get_vault_header(v.sourceG.vault)).state,
    );
  const normalA = await f.fresh({ Normal: null }, [a.target], a.candidate);
  for (const purpose of [
    { Normal: null },
    { Credentials: null },
    { Create: null },
    { Cleanup: { job: b(181) } },
  ]) {
    await assert.rejects(
      f.fresh(purpose, [C.sourceG], a.candidate),
      /Unauthorized|Conflict/,
    );
  }
  assert.deepEqual(
    (
      await f.send(normalA, {
        PurgeObject: { vault: C.sourceG.vault, object: b(20) },
      })
    ).result,
    { Err: { Unauthorized: null } },
  );
  assert.deepEqual(
    (
      await f.send(normalA, {
        DeleteObject: {
          vault: C.sourceG.vault,
          object: b(20),
          expected_revision: 2n,
          operation: b(182),
        },
      })
    ).result,
    { Err: { Unauthorized: null } },
  );
  assert.deepEqual(
    (
      await f.send(normalA, {
        Derive: {
          vault: C.sourceG.vault,
          epoch: C.sourceG.epoch,
          attempt: [],
          assertion: [],
          transport: cryptoLib.TransportSecretKey.random().publicKeyBytes(),
        },
      })
    ).result,
    { Err: { Unauthorized: null } },
  );
  const bRestore = await prepare(f, sourceB, {
    id: 120,
    candidate: a.candidate,
    existing: true,
  });
  await importAndActivate(f, bRestore);
  assert.deepEqual(
    (
      await f.send(normalA, {
        PurgeObject: { vault: a.target.vault, object: b(20) },
      })
    ).result,
    { Err: { Unauthorized: null } },
  );
  const combined = ok(await f.actor.incident_context())[0].credentials;
  assert.equal(combined.filter((c) => !c.revoked).length, 10);
  assert.equal(
    combined.find((c) => b64(c.credential) === b64(a.candidate.id)).scope
      .Instances.length,
    2,
  );
  await f.pic.advanceTime(421_000);
  const retainedGrant = await f.fresh(
    { Normal: null },
    [a.target, bRestore.target],
    a.candidate,
  );
  const transport = cryptoLib.TransportSecretKey.random();
  const handle = ok(
    (
      await f.send(retainedGrant, {
        Derive: {
          vault: a.target.vault,
          epoch: a.target.epoch,
          attempt: [],
          assertion: [],
          transport: transport.publicKeyBytes(),
        },
      })
    ).result,
  ).Handle;
  const reply = ok(
    (await f.send(retainedGrant, { KeyResult: { handle } })).result,
  ).Key;
  const kek = await cryptoLib.verifiedGenerationKEK(
    new Uint8Array(reply.encrypted_key),
    transport,
    f.cryptoG(a.target),
    true,
  );
  const active = ok(await f.actor.get_vault_header(a.target.vault));
  const opened = await cryptoLib.openV2(
    kek,
    active.normal[0],
    cryptoLib.generationAAD(f.cryptoG(a.target), b(0), 0n, "normal"),
  );
  assert.equal(b64(opened), b64(a.transformed.rootRaw));
  opened.fill(0);
  await assert.rejects(
    f.fresh({ Normal: null }, [C.sourceG], a.candidate),
    /Unauthorized|Conflict/,
  );
  ok(await f.actor.incident_status());
  const resumed = await f.fresh(
    {
      IncidentPrepare: {
        job: parent.job,
        namespace: parent.namespace,
        compromised: parent.compromised,
        sources: [C.sourceG],
        targets: [
          {
            namespace: parent.namespace,
            vault: C.sourceG.vault,
            attempt: parent.targets[2].attempt,
          },
        ],
      },
    },
    [C.sourceG],
  );
  assert.ok(
    "Err" in
      (
        await f.send(resumed, {
          IncidentAllocate: {
            vault: f.sourceG.vault,
            attempt: parent.targets[0].attempt,
          },
        })
      ).result,
  );
  ok(
    (
      await f.send(resumed, {
        IncidentAllocate: {
          vault: C.sourceG.vault,
          attempt: parent.targets[2].attempt,
        },
      })
    ).result,
  );
  assert.deepEqual(
    ok(await f.actor.get_vault_header(a.target.vault)).generation,
    [a.target],
  );
  assert.ok(
    "IncidentRequired" in
      ok(await f.actor.get_vault_header(C.sourceG.vault)).state,
  );
  // An allocated but unresolved original still blocks parent completion.
  assert.ok("Err" in (await f.actor.incident_cutover_digest()));
  if (process.env.VAULT_PARENT_MIXED === "1") {
    const { completeRemainingParent } = await import(
      "../helpers/vault-parent-cutover.mjs"
    );
    await completeRemainingParent(f, C, parent, [a.target, bRestore.target]);
  } else {
    await f.pic.advanceTime(421_000);
    const cRestore = await prepare(f, sourceC, {
      id: 180,
      candidate: a.candidate,
      existing: true,
    });
    await importAndActivate(f, cRestore, {
      afterRecordStage: async (n) => {
        if (n !== 0) return;
        const terminal = ok(await f.actor.incident_status())[0];
        assert.ok(
          terminal.complete &&
            terminal.targets.every((t) => "Purged" in t.phase),
        );
        assert.deepEqual(terminal.completed_digest, []);
        const child = ok(await f.actor.restore_admission_status())[0];
        assert.ok(!("Active" in child.pipeline[0].phase));
        assert.ok(
          "Err" in (await f.actor.set_config([])),
          "Terminal parent cannot bypass pending child's config guard",
        );
        assert.ok(
          "Err" in
            (await f.send(cRestore.grant, { RestoreActivate: null })).result,
        );
        await f.pic.advanceTime(421_000);
        assert.equal(
          ok(await f.actor.list_vaults()).length,
          2,
          "Only active A/B replacements are published while C remains staged",
        );
        assert.deepEqual(
          ok(await f.actor.restore_admission_status())[0],
          child,
        );
        cRestore.grant = await resume(f, cRestore);
      },
    });
    const replacements = [a.target, bRestore.target, cRestore.target];
    const allResolved = ok(await f.actor.incident_status())[0];
    assert.ok(allResolved.targets.every((t) => "Purged" in t.phase));
    assert.ok(allResolved.complete);
    assert.deepEqual(allResolved.completed_digest, []);
    assert.ok("Conflict" in (await f.actor.incident_cutover_digest()).Err);
    assert.ok(
      "Err" in
        (await f.send(resumed, { IncidentCutover: { digest: b(0, 32) } }))
          .result,
    );
    for (const g of replacements) {
      const h = ok(await f.actor.get_vault_header(g.vault));
      assert.deepEqual(h.generation, [g]);
      assert.ok("Active" in h.state);
    }
    const keyState = ok(await f.actor.incident_context())[0].credentials.find(
      (c) => b64(c.credential) === b64(a.candidate.id),
    );
    assert.equal(keyState.scope.Instances.length, 3);
    assert.ok(!("Global" in keyState.scope));
    for (const original of [f.sourceG, B.sourceG, C.sourceG])
      await assert.rejects(
        f.fresh({ Normal: null }, [original], a.candidate),
        /Unauthorized|Conflict/,
      );
    console.log(
      "PASS terminal nested replacements: unresolved C blocks; all original obligations Purged; stale proof denied; independently proved child activation resolves all originals; no fabricated parent cutover without resurrecting old generations or promoting Global",
    );
  }
  console.log(
    "PASS actual three-target parent: 10-key new-candidate rejection before discard; revoke to nine then restore encrypted A to ten; preserved frozen B/C; same physical key independently restores B at ten; A retained/C denied; parent resumes C without resurrecting A",
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await f.close();
}
