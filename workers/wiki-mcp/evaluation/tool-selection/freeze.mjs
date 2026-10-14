import { readFile, writeFile } from "node:fs/promises";
import { here, hash } from "./build.mjs";

// Run only after development is complete. This never launches model sessions.
const round = process.argv[2];
if (!["r0", "r1", "r2"].includes(round)) throw Error("Specify r0, r1 or r2");
const paths = [
  "cases.mjs",
  "corpus-lock.json",
  "grade.mjs",
  "select.mjs",
  "backend.mjs",
  "build.mjs",
  "server.mjs",
  "run.mjs",
  "baseline/SKILL.md",
  "baseline/tools.md",
  ...["index.ts.txt", "SKILL.md", "tools.md"].map(
    (name) => `variants/${round}/${name}`,
  ),
];
const files = {};
for (const path of paths) files[path] = hash(await readFile(here + path));
await writeFile(
  here + "holdout-lock.json",
  JSON.stringify({ round, files }, null, 2) + "\n",
  { flag: "wx" },
);
