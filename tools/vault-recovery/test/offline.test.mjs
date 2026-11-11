import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeArchive } from "../../../packages/vault-backup/src/index.ts";
import {
  aad,
  deriveKey,
  importKey,
  randomBytes,
  seal,
} from "../../../packages/vault-crypto/src/index.ts";
import {
  b64,
  pack,
  encryptDocument,
} from "../../../packages/vault-crypto/src/documents.ts";
test("standalone CLI recovers synthetic bytes and never prints the secret or contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kinic-vault-recovery-"));
  try {
    const raw = randomBytes(32),
      secret = randomBytes(32),
      vault = randomBytes(16),
      object = randomBytes(16),
      root = await importKey(raw),
      plain = new TextEncoder().encode("synthetic recovery test");
    const d = await encryptDocument(
      root,
      vault,
      object,
      1n,
      { kind: "note", title: "synthetic title" },
      plain,
    );
    const h = {
      version: 1,
      vault: b64(vault),
      epoch: "0",
      sequence: "2",
      key_name: "test_key_1",
      record_count: 1,
      chunk_count: 1,
      plain_bytes: String(plain.length),
      normal: pack(
        await seal(root, raw, aad(vault, new Uint8Array(16), 0n, "normal")),
      ),
      recovery: pack(
        await seal(
          await deriveKey(secret, "recovery"),
          raw,
          aad(vault, new Uint8Array(16), 0n, "recovery"),
        ),
      ),
    };
    const r = {
      vault: h.vault,
      object: b64(object),
      revision: "1",
      sequence: "2",
      plain_size: String(plain.length),
      manifest: b64(d.manifest),
      hashes: d.hashes.map(b64),
      deleted: false,
    };
    await writeFile(
      join(dir, "backup"),
      await makeArchive(h, [r], async (_, i) => d.chunks[i], raw),
    );
    await writeFile(join(dir, "secret"), b64(secret));
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "tools/vault-recovery/src/main.mjs",
          "--backup",
          join(dir, "backup"),
          "--output",
          join(dir, "out"),
          "--secret-file",
          join(dir, "secret"),
        ],
        { encoding: "utf8" },
      );
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes(b64(secret)));
    assert.ok(
      !(result.stdout + result.stderr).includes("synthetic recovery test"),
    );
    assert.deepEqual(
      new Uint8Array(
        await readFile(
          join(dir, "out", Buffer.from(object).toString("hex") + "-1.bin"),
        ),
      ),
      plain,
    );
    assert.notEqual(run().status, 0); // Existing output is never overwritten.
    const guard = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import './tools/vault-recovery/src/offline.mjs';import net from 'node:net';try{net.connect(443,'example.com');process.exit(2)}catch(e){process.exit(e.message==='NetworkForbidden'?0:1)}`,
    ]);
    assert.equal(guard.status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
