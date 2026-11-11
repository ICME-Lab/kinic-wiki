import { expect, it } from "vitest";
import { Session } from "@kinic/vault-client/session";
import {
  makeArchive,
  openArchive,
  transformArchive,
} from "@kinic/vault-backup";
import {
  aad,
  deriveKey,
  seal,
  randomBytes,
  importKey,
} from "@kinic/vault-crypto";
import { b64, pack } from "@kinic/vault-crypto/documents";
import { legacySource } from "./recovery-shared";
it("accepts original raw v1 secret, fully verifies the source and transforms it to a fresh v2 target", async () => {
  const vault = randomBytes(16),
    raw = randomBytes(32),
    secret = randomBytes(32),
    session = new Session(),
    held: Uint8Array[] = [];
  const recovery = await seal(
    await deriveKey(secret, "recovery"),
    raw,
    aad(vault, new Uint8Array(16), 0n, "recovery"),
  );
  const archive = await makeArchive(
    {
      version: 1,
      vault: b64(vault),
      epoch: "0",
      sequence: "0",
      key_name: "test_key_1",
      record_count: 0,
      chunk_count: 0,
      plain_bytes: "0",
      normal: pack(recovery),
      recovery: pack(recovery),
    },
    [],
    async () => new Uint8Array(),
    raw,
  );
  const source = await legacySource(archive, b64(secret), session, (b) => {
    held.push(b);
    return b;
  });
  const target = await transformArchive(
    archive,
    source.secret,
    {
      version: 2,
      canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      owner: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      vault,
      nonce: randomBytes(32),
      epoch: 1n,
      key_name: "key_1",
    },
    await importKey(randomBytes(32)),
  );
  const opened = await openArchive(target.archive, target.recoverySecret);
  expect(opened.header.version).toBe(2);
  expect(opened.header.envelope_revision).toBe("0");
  opened.rootRaw.fill(0);
  target.rootRaw.fill(0);
  target.recoverySecret.fill(0);
  for (const bad of [
    "",
    b64(secret) + "=",
    b64(secret) + "\n",
    "!",
    b64(randomBytes(31)),
  ])
    await expect(
      legacySource(archive, bad, session, (b) => b),
    ).rejects.toThrow();
  const damaged = archive.slice();
  damaged[damaged.length - 1] ^= 1;
  await expect(
    legacySource(damaged, b64(secret), session, (b) => b),
  ).rejects.toThrow();
  held.forEach((b) => b.fill(0));
  expect(source.secret.every((x) => x === 0)).toBe(true);
});
it("binds helper invocations to the mounted private generation across asynchronous continuations", async () => {
  const { bindRecovery } = await import("./recovery-shared");
  const session = new Session();
  let writes = 0;
  const service = {
    async next() {
      writes++;
    },
    async cutover() {
      session.lock();
      return "done";
    },
  };
  const bound = bindRecovery(service, session);
  expect(await bound.cutover()).toBe("done");
  expect(() => bound.next()).toThrow("Locked");
  expect(writes).toBe(0);
});
it("does not invoke a second actor request after a late first response crosses lock", async () => {
  const { bindRecovery } = await import("./recovery-shared");
  const session = new Session();
  let first!: () => void,
    requests = 0;
  const actor = {
    first: () =>
      new Promise<void>((resolve) => {
        first = resolve;
      }),
    second: () => {
      requests++;
    },
  };
  const bound = bindRecovery(actor, session),
    workflow = (async () => {
      await bound.first();
      bound.second();
    })();
  session.lock();
  first();
  await expect(workflow).rejects.toThrow("Locked");
  expect(requests).toBe(0);
});
