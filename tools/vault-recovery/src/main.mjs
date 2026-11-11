import "./offline.mjs";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { openArchive, headerGeneration } from "../../../packages/vault-backup/src/index.ts";
import {
  unb64,
  decryptDocument,
} from "../../../packages/vault-crypto/src/documents.ts";
async function promptSecret() {
  if (!process.stdin.isTTY) throw Error("SecretFileRequired");
  process.stderr.write("Recovery secret (hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      let value = "";
      const listen = (chunk) => {
        for (const c of chunk.toString()) {
          if (c === "\u0003") {
            process.stdin.off("data", listen);
            reject(Error("Cancelled"));
            return;
          }
          if (c === "\r" || c === "\n") {
            process.stdin.off("data", listen);
            resolve(value);
            return;
          }
          if (c === "\u007f") {
            value = value.slice(0, -1);
          } else if (/[A-Za-z0-9_-]/.test(c) && value.length < 64) {
            value += c;
          }
        }
      };
      process.stdin.on("data", listen);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\n");
  }
}
let output,
  created = false,
  opened;
try {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    if (
      !["--backup", "--output", "--secret-file"].includes(name) ||
      !process.argv[i + 1] ||
      args.has(name)
    )
      throw Error("Usage");
    args.set(name, process.argv[i + 1]);
  }
  if (!args.has("--backup") || !args.has("--output")) throw Error("Usage");
  const backup = resolve(args.get("--backup"));
  output = resolve(args.get("--output"));
  if ((await stat(backup)).size > 256 * 1024 * 1024) throw Error("SizeLimit");
  let text;
  if (args.has("--secret-file")) {
    const path = resolve(args.get("--secret-file"));
    if ((await stat(path)).size > 128) throw Error("InvalidSecret");
    text = (await readFile(path, "utf8")).trim();
  } else {
    text = await promptSecret();
  }
  const secret = unb64(text);
  text = "";
  if (secret.length !== 32) throw Error("InvalidSecret");
  try {
    opened = await openArchive(new Uint8Array(await readFile(backup)), secret);
  } finally {
    secret.fill(0);
  }
  // Refuse an existing directory. Never use untrusted document titles or filenames as filesystem paths.
  await mkdir(output, { mode: 0o700 });
  created = true;
  const index = [];
  for (let i = 0; i < opened.records.length; i++) {
    const r = opened.records[i];
    if (r.deleted) continue;
    const doc = await decryptDocument(
      opened.root,
      unb64(r.vault),
      unb64(r.object),
      BigInt(r.revision),
      unb64(r.manifest),
      opened.chunks[i],
      r.hashes.map(unb64),
      headerGeneration(opened.header),
    );
    const filename =
      Buffer.from(unb64(r.object)).toString("hex") + "-" + r.revision + ".bin";
    try {
      await writeFile(join(output, filename), doc.plaintext, {
        flag: "wx",
        mode: 0o600,
      });
    } finally {
      doc.plaintext.fill(0);
    }
    index.push({
      file: filename,
      revision: r.revision,
      metadata: doc.metadata,
    });
  }
  await writeFile(join(output, "index.json"), JSON.stringify(index, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    "Recovery completed. Plaintext files are in the selected output directory.\n",
  );
} catch (error) {
  if (created) await rm(output, { recursive: true, force: true });
  process.stderr.write(
    "Recovery failed. Check the backup, secret and output directory.\n",
  );
  process.exitCode = 1;
} finally {
  opened?.rootRaw.fill(0);
}
