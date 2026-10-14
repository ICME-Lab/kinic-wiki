import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { BASELINE_COMMIT, cases } from "./cases.mjs";
export const here = fileURLToPath(new URL(".", import.meta.url));
export const root = fileURLToPath(new URL("../../", import.meta.url));
export const hash = (x) => createHash("sha256").update(x).digest("hex");
const lock = JSON.parse(await readFile(here + "corpus-lock.json", "utf8"));
if (hash(JSON.stringify(cases)) !== lock.sha256)
  throw Error("Frozen corpus changed");
export async function buildVariants(round = "r0") {
  await mkdir(here + `.tmp-test/${round}`, { recursive: true });
  for (const variant of ["A", "B", "C"]) {
    const source =
      variant === "A"
        ? execFileSync(
            "git",
            ["show", BASELINE_COMMIT + ":workers/wiki-mcp/src/index.ts"],
            { cwd: root, encoding: "utf8" },
          )
        : await readFile(here + `variants/${round}/index.ts.txt`, "utf8");
    let contents = source;
    if (variant === "C") {
      const start = contents.indexOf(
        '  server.registerTool(\n    "read_path",',
      );
      if (start < 0)
        throw Error("C experiment requires B read_path registration");
      const end = contents.indexOf("  server.registerTool(", start + 25);
      contents = contents.slice(0, start) + contents.slice(end);
      contents = contents
        .replace("min(2).max(MAX_READ_PATHS)", "min(1).max(MAX_READ_PATHS)")
        .replaceAll(
          "read_path for one known path and read_paths for 2-10 known paths",
          "read_paths for 1-10 known paths",
        )
        .replaceAll(
          "Read 2 to 10 exact known paths",
          "Read 1 to 10 exact known paths",
        )
        .replaceAll(
          "For one path use read_path; for search ids or URLs use fetch_many.",
          "For search ids or URLs use fetch_many.",
        );
    }
    await build({
      stdin: {
        contents,
        loader: "ts",
        resolveDir: root + "src",
        sourcefile: "index.ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: here + `.tmp-test/${round}/${variant}.mjs`,
      alias: { "cloudflare:workers": root + "tests/cloudflare-workers.ts" },
      banner: {
        js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
      },
      plugins: [
        {
          name: "fixture-vfs",
          setup(b) {
            b.onLoad({ filter: /\/src\/vfs\.ts$/ }, async () => ({
              contents: await readFile(here + "backend.mjs", "utf8"),
              loader: "js",
              resolveDir: here,
            }));
          },
        },
      ],
    });
    await writeFile(
      here + `.tmp-test/${round}/${variant}-source.sha256`,
      hash(contents),
    );
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await buildVariants(process.argv[2] ?? "r0");
