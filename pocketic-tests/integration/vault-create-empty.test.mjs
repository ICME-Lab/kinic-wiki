import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  restoreFixture,
  b,
  key,
  ok,
  owner,
  other,
  IDL,
  registration,
  assertion,
  cryptoLib,
} from "../helpers/vault-restore-fixture.mjs";
const {
  TransportSecretKey,
  verifiedGenerationKEK,
  randomBytes,
  sealV2,
  openV2,
  deriveKey,
  generationAAD,
  recoveryVerifier,
} = cryptoLib;
async function scoped(f) {
  const c = { ...key(), id: b(77) },
    scope = { Instances: [{ vault: f.sourceG.vault, nonce: f.sourceG.nonce }] };
  const ch = ok(
    (
      await f.send(f.bootstrap, {
        BeginRegistration: { vault: f.sourceG.vault, scope },
      })
    ).result,
  ).Challenge;
  ok(
    (
      await f.send(f.bootstrap, {
        RegisterCredential: {
          vault: f.sourceG.vault,
          scope,
          registration: registration(ch, c),
        },
      })
    ).result,
  );
  return c;
}
async function start(f, c, id = 2) {
  const namespace = ok(await f.actor.incident_context())[0].namespace;
  const purpose = {
    CreateEmpty: {
      job: b(100 + id),
      target: { namespace, vault: b(id), attempt: b(110 + id) },
      authorizer_instance: f.sourceG,
    },
  };
  const grant = await f.fresh(purpose, [f.sourceG], c);
  return { purpose, grant, j: ok(await f.actor.create_empty_status())[0] };
}
async function allocate(f, r) {
  const sent = await f.send(r.grant, { CreateEmptyAllocate: null }),
    handle = ok(sent.result).Handle;
  assert.deepEqual(
    await f.actor.mutate(sent.payload, sent.signature),
    sent.result,
    "exact retry must return the allocation receipt",
  );
  ok((await f.send(r.grant, { KeyResult: { handle } })).result);
  r.j = ok(await f.actor.create_empty_status())[0];
  return r.j.generation[0];
}
async function derive(f, grant, j, normal = false, publicKeys) {
  const g = j.generation[0],
    transport = TransportSecretKey.random();
  const operation = normal
    ? {
        Derive: {
          vault: g.vault,
          epoch: g.epoch,
          attempt: [],
          assertion: [],
          transport: transport.publicKeyBytes(),
        },
      }
    : {
        CreateEmptyDerive: {
          job: j.job,
          attempt: j.target.attempt,
          generation: g,
          role: { Target: null },
          transport: transport.publicKeyBytes(),
        },
      };
  const handle = ok((await f.send(grant, operation)).result).Handle;
  const reply = ok((await f.send(grant, { KeyResult: { handle } })).result).Key;
  publicKeys?.set(g.key_name, new Uint8Array(reply.public_key));
  return verifiedGenerationKEK(
    new Uint8Array(reply.encrypted_key),
    transport,
    f.cryptoG(g),
    true,
  );
}
async function stage(f, r, publicKeys) {
  const g = r.j.generation[0],
    kek = await derive(f, r.grant, r.j, false, publicKeys),
    raw = randomBytes(32),
    secret = randomBytes(32);
  const normal = await sealV2(
    kek,
    raw,
    generationAAD(f.cryptoG(g), b(0), 0n, "normal"),
  );
  const recovery = await sealV2(
    await deriveKey(secret, "recovery"),
    raw,
    generationAAD(f.cryptoG(g), b(0), 0n, "recovery"),
  );
  const recovery_verifier = await recoveryVerifier(secret);
  ok(
    (
      await f.send(r.grant, {
        CreateEmptyStage: { normal, recovery, recovery_verifier },
      })
    ).result,
  );
  r.j = ok(await f.actor.create_empty_status())[0];
  assert.deepEqual(
    await openV2(
      kek,
      r.j.normal[0],
      generationAAD(f.cryptoG(g), b(0), 0n, "normal"),
    ),
    raw,
  );
  assert.deepEqual(
    await openV2(
      await deriveKey(secret, "recovery"),
      r.j.recovery[0],
      generationAAD(f.cryptoG(g), b(0), 0n, "recovery"),
    ),
    raw,
  );
  ok(
    (
      await f.send(r.grant, {
        CreateEmptyConfirmKit: { envelope_digest: r.j.envelope_digest },
      })
    ).result,
  );
  return { raw, secret, kek };
}
console.log(
  "ARTIFACT",
  createHash("sha256")
    .update(
      readFileSync(
        new URL(
          "../../target/vault-synthetic-funding-build/wasm32-unknown-unknown/release/vault_canister.wasm",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
);
{
  const f = await restoreFixture(undefined, { testThresholdKeys: true });
  try {
    const c = await scoped(f);
    await f.pic.advanceTime(421000);
    const defaultA = ok(await f.actor.get_config())[0];
    assert.equal(defaultA.key_name, "key_1");
    assert.equal(f.sourceG.key_name, defaultA.key_name);
    const defaultB = { ...defaultA, key_name: "test_key_1" };
    ok(await f.actor.set_config([defaultB]));
    const oldSource = await f.fresh({ Normal: null }, [f.sourceG], c);
    const r = await start(f, c);
    assert.ok("Err" in await f.actor.set_config([defaultA]), "pending creation must pin target configuration");
    const forged = { ...f.sourceG, key_name: defaultB.key_name };
    assert.ok("Err" in await f.actor.begin_grant({
      operation: b(199), public_key: f.ephemeral.public, credential: c.id,
      purpose: { CreateEmpty: { ...r.purpose.CreateEmpty, authorizer_instance: forged } },
      generations: [forged],
    }));
    const context = ok(await f.actor.incident_context())[0];
    assert.equal(ok(await f.actor.list_credentials()).length, 2);
    assert.equal(r.j.generation.length, 0);
    assert.ok(
      "Err" in
        (await f.actor.begin_grant({
          operation: b(200),
          public_key: f.ephemeral.public,
          credential: c.id,
          purpose: { Create: null },
          generations: [],
        })),
    );
    assert.ok(
      "Err" in
        (await f.actor.begin_grant({
          operation: b(201),
          public_key: f.ephemeral.public,
          credential: c.id,
          purpose: {
            CreateEmpty: {
              ...r.purpose.CreateEmpty,
              target: { ...r.j.target, vault: f.sourceG.vault },
            },
          },
          generations: [f.sourceG],
        })),
    );
    assert.ok(
      "Err" in
        (await f.actor.begin_grant({
          operation: b(202),
          public_key: f.ephemeral.public,
          credential: f.credential.id,
          purpose: r.purpose,
          generations: [f.sourceG],
        })),
    );
    let target = await allocate(f, r);
    assert.equal(target.key_name, defaultB.key_name);
    assert.notEqual(target.key_name, f.sourceG.key_name);
    assert.ok(
      "Err" in
        (await f.actor.begin_grant({
          operation: b(203),
          public_key: f.ephemeral.public,
          credential: f.credential.id,
          purpose: { Normal: null },
          generations: [target],
        })),
    );
    assert.ok(
      "Err" in (await f.send(r.grant, { RestoreBeginImport: null })).result,
    );
    assert.ok(
      "Err" in
        (
          await f.send(r.grant, {
            CreateEmptyDerive: {
              job: r.j.job,
              attempt: r.j.target.attempt,
              generation: f.sourceG,
              role: { Source: null },
              transport: TransportSecretKey.random().publicKeyBytes(),
            },
          })
        ).result,
    );
    const before = r.j;
    await f.pic.upgradeCanister({
      sender: owner,
      canisterId: f.canisterId,
      wasm: f.wasm,
      arg: IDL.encode([], []),
    });
    assert.deepEqual(ok(await f.actor.create_empty_status())[0], before);
    assert.ok(
      "Err" in (await f.send(r.grant, { CreateEmptyActivate: null })).result,
    );
    r.grant = await f.fresh(r.purpose, [f.sourceG], c);
    const publicKeys = new Map();
    const keys = await stage(f, r, publicKeys);
    ok((await f.send(r.grant, { CreateEmptyActivate: null })).result);
    r.j = ok(await f.actor.create_empty_status())[0];
    assert.ok("Active" in r.j.phase);
    assert.equal(ok(await f.actor.list_credentials()).length, 2);
    assert.ok(
      "Err" in
        (await f.send(oldSource, { KeyResult: { handle: b(1, 32) } })).result,
    );
    assert.ok(
      "Err" in
        (await f.actor.cancel_create_empty(
          r.j.job,
          r.j.target,
          r.j.generation,
          0n,
        )),
    );
    await f.pic.advanceTime(421000);
    const fresh = await f.fresh({ Normal: null }, [target], c),
      targetKEK = await derive(f, fresh, r.j, true);
    assert.deepEqual(
      await openV2(
        targetKEK,
        r.j.normal[0],
        generationAAD(f.cryptoG(target), b(0), 0n, "normal"),
      ),
      keys.raw,
    );
    const sourceGrant = await f.fresh({ Normal: null }, [f.sourceG], c);
    const sourceKEK = await derive(
      f,
      sourceGrant,
      { generation: [f.sourceG] },
      true,
      publicKeys,
    );
    assert.ok(publicKeys.get("key_1")?.length > 0);
    assert.ok(publicKeys.get("test_key_1")?.length > 0);
    assert.notDeepEqual(publicKeys.get("key_1"), publicKeys.get("test_key_1"));
    const sourceHeader = ok(await f.actor.get_vault_header(f.sourceG.vault));
    assert.deepEqual(
      await openV2(
        sourceKEK,
        sourceHeader.normal[0],
        generationAAD(f.cryptoG(f.sourceG), b(0), 0n, "normal"),
      ),
      f.sourceRaw,
    );
    await assert.rejects(
      openV2(
        sourceKEK,
        r.j.normal[0],
        generationAAD(f.cryptoG(target), b(0), 0n, "normal"),
      ),
    );
    const latest = ok(await f.actor.incident_context())[0],
      entry = latest.credentials.find((x) =>
        Buffer.from(x.credential).equals(c.id),
      );
    assert.ok(
      entry.version >
        context.credentials.find((x) => Buffer.from(x.credential).equals(c.id))
          .version,
    );
    assert.ok("Instances" in entry.scope);
    assert.equal(entry.scope.Instances.length, 2);
    console.log(
      "PASS current Wasm fresh scoped UV, exact allocation receipt, Global/Normal/restore/role isolation, durable upgrade+fresh proof, two independent roots, same physical key, old-grant rejection, fresh target/source unlock",
    );
  } finally {
    await f.close();
  }
}
for (const rounds of [0, 1, 3, 4]) {
  const f = await restoreFixture(undefined, { credits: 100_000_000_000n });
  try {
    const c = await scoped(f);
    await f.pic.advanceTime(421000);
    const r = await start(f, c);
    let flight;
    const startingBalance = ok(await f.actor.account_balance());
    if (rounds === 0) {
      flight = await f.send(
        r.grant,
        { CreateEmptyAllocate: null },
        { deferred: true },
      );
      await f.pic.tick(1);
    } else {
      await allocate(f, r);
      flight = await f.send(
        r.grant,
        {
          CreateEmptyDerive: {
            job: r.j.job,
            attempt: r.j.target.attempt,
            generation: r.j.generation[0],
            role: { Target: null },
            transport: TransportSecretKey.random().publicKeyBytes(),
          },
        },
        { deferred: true },
      );
      await f.pic.tick(rounds === 4 ? 1 : rounds);
      if (rounds === 1 || rounds === 3) {
        await f.pic.advanceTime(121000);
        await f.pic.tick(5);
      }
    }
    r.j = ok(await f.actor.create_empty_status())[0];
    let cancelled = await f.actor.cancel_create_empty(
      r.j.job,
      r.j.target,
      r.j.generation,
      0n,
    );
    if ("Err" in cancelled) {
      // A nonce may publish between status and update; the stale pre-nonce identity must fail.
      assert.ok("Unauthorized" in cancelled.Err);
      r.j = ok(await f.actor.create_empty_status())[0];
      cancelled = await f.actor.cancel_create_empty(
        r.j.job,
        r.j.target,
        r.j.generation,
        0n,
      );
    }
    let p = ok(cancelled);
    await f.pic.tick(5);
    const done = await flight.complete();
    const handle = ok(done.result).Handle;
    assert.ok(
      "Err" in (await f.send(r.grant, { KeyResult: { handle } })).result,
      "cancelled callback must never release a key",
    );
    const spent = startingBalance - ok(await f.actor.account_balance());
    if (rounds === 1)
      assert.ok(
        spent < 1_000_000_000n,
        `public-key cancellation sent a paid derive: ${spent}`,
      );
    if (rounds === 3)
      assert.ok(
        spent > 1_000_000_000n,
        `encrypted-key await was not reached: ${spent}`,
      );
    if (!p.complete)
      p = ok(
        await f.actor.cancel_create_empty(
          r.j.job,
          r.j.target,
          r.j.generation,
          p.cursor,
        ),
      );
    assert.ok(p.complete);
    assert.ok("Cancelled" in ok(await f.actor.create_empty_status())[0].phase);
    const wrong = { ...r.j.target, attempt: b(254) };
    assert.ok(
      "Err" in
        (await f.actor.cancel_create_empty(
          r.j.job,
          wrong,
          r.j.generation,
          p.cursor,
        )),
    );
    f.actor.setPrincipal(other);
    assert.ok(
      "Err" in
        (await f.actor.cancel_create_empty(
          r.j.job,
          r.j.target,
          r.j.generation,
          p.cursor,
        )),
    );
    f.actor.setPrincipal(owner);

    await f.pic.advanceTime(421000);
    const retry = await start(f, c, 2).catch(() => null);
    assert.equal(retry, null, "same cancelled job must not resume");
    const namespace = r.j.target.namespace,
      purpose = {
        CreateEmpty: {
          job: b(240),
          target: { namespace, vault: b(2), attempt: b(241) },
          authorizer_instance: f.sourceG,
        },
      };
    const newer = await f.fresh(purpose, [f.sourceG], c);
    assert.ok(
      "Err" in
        (await f.actor.cancel_create_empty(
          r.j.job,
          r.j.target,
          r.j.generation,
          p.cursor,
        )),
    );
    const current = ok(await f.actor.create_empty_status())[0];
    await f.pic.advanceTime(40 * 365 * 24 * 60 * 60 * 1000);
    await f.pic.tick(3);
    assert.equal(ok(await f.actor.account_balance()), 0n);
    assert.ok(
      ok(await f.actor.cancel_create_empty(current.job, current.target, [], 0n))
        .complete,
    );
    assert.ok(
      "Active" in ok(await f.actor.get_vault_header(f.sourceG.vault)).state,
    );
    console.log(
      `PASS actual ${rounds === 0 ? "raw_rand" : rounds === 1 ? "expired public-key" : rounds === 3 ? "expired encrypted-key" : "live key-race"} callback cancellation, exact owner/attempt binding, newer retry protected, zero-balance pre-nonce cancellation, source retained`,
    );
  } finally {
    await f.close();
  }
}
console.log("PASS all scoped-empty actual-Wasm scenarios including teardown");
