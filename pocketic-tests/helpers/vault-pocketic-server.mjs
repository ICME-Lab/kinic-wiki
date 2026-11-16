// @dfinity/pic 0.21 uses a shared PPID port-file and may read stale startup data.
// Each acceptance fixture owns one unique port-file and waits for its own child.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
export async function startVaultPocketIc(binary) {
  const dir = await mkdtemp(join(tmpdir(), "vault-pocketic-"));
  const portFile = join(dir, "port");
  const child = spawn(binary, ["--port-file", portFile], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let error,
    stderr = "";
  child.on("error", (e) => {
    error = e;
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16384);
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  async function stop() {
    if (error && child.pid === undefined) {
      await rm(dir, { recursive: true, force: true });
      return;
    }
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      delay(10_000, undefined, { ref: false }).then(() => {
        throw Error("PocketIC shutdown timed out");
      }),
    ]);
    await rm(dir, { recursive: true, force: true });
    if (result.code !== 0 && result.signal !== "SIGTERM")
      throw Error(`PocketIC exited ${JSON.stringify(result)}: ${stderr}`);
  }
  try {
    for (let i = 0; i < 300; i++) {
      if (error) throw error;
      if (child.exitCode !== null || child.signalCode !== null)
        throw Error(`PocketIC startup exited: ${stderr}`);
      const port = Number(
        await readFile(portFile, "utf8").catch((e) => {
          if (e.code !== "ENOENT") throw e;
          return "";
        }),
      );
      if (port > 0 && port < 65536)
        return { getUrl: () => `http://127.0.0.1:${port}`, stop };
      await delay(100);
    }
    throw Error("PocketIC startup timed out");
  } catch (e) {
    await stop();
    throw e;
  }
}
