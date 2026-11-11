import assert from "node:assert/strict";
import {
  restoreFixture,
  b,
  b64,
  key,
} from "../helpers/vault-restore-fixture.mjs";
import {
  sourceArchive,
  prepare,
  importAndActivate,
} from "../helpers/vault-restore-pipeline.mjs";
import { externalArchive } from "../helpers/vault-restore-archive.mjs";
const f = await restoreFixture();
try {
  for (const version of [1, 2]) {
    await f.pic.advanceTime(421_000);
    const source = await externalArchive(version, b(version + 1));
    const r = await prepare(f, source, {
      id: 120 + version * 10,
      candidate: { ...key(), id: b(43 + version) },
    });
    assert.equal(r.current, undefined);
    assert.equal(r.target.epoch, version === 1 ? 1n : 8n);
    await importAndActivate(f, r);
  }
  console.log(
    "PASS actual Wasm absent v1/v2 import, source epochs0/7→target1/8, encrypted history/chunks and independent offline source/target recovery",
  );
  const source = await sourceArchive(f);
  const other = await restoreFixture(undefined, { priorCanisters: 1 });
  try {
    assert.notEqual(f.canisterId.toText(), other.canisterId.toText());
    const first = await prepare(other, source, {
      currentSecret: other.sourceSecret,
    });
    const current = await importAndActivate(other, first);
    const second = await prepare(other, source, {
      id: 150,
      candidate: first.candidate,
      existing: true,
      currentSecret: current.secret,
    });
    assert.equal(second.target.epoch, 2n);
    assert.notEqual(b64(first.target.nonce), b64(second.target.nonce));
    await importAndActivate(other, second);
    console.log(
      "PASS actual Wasm same owner/different source canister, distinct archive/current kit proofs, old source epoch0 with live epoch1→fresh epoch2, old-kit denial after activation",
    );
  } finally {
    await other.close();
  }
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await f.close();
}
