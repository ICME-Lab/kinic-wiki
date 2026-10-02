import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run against a local server or a safe read-only page; no authenticated data is required.
const target = process.argv[2] ?? process.env.WIKI_BROWSER_BASE_URL;
if (!target || !["http:", "https:"].includes(new URL(target).protocol)) {
  throw new Error("Provide an HTTP(S) page URL: pnpm quality:ui http://127.0.0.1:3010/db/<databaseId>/Knowledge");
}
const gates = [
  ["check", "integrity"],
  ["check", "a11y", "contrast"],
  ["check", "interactions"],
  ["scan", "handlers"],
  ["scan", "scroll"]
];
for (const gate of gates) {
  const result = spawnSync("pnpm", ["exec", "vlmkit", ...gate, target], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
