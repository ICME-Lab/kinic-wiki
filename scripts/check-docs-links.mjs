// Where: scripts/check-docs-links.mjs
// What: Verify that relative markdown links under docs/ resolve to real files.
// Why: The docs index must not rot as files move.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const files = execSync("git ls-files 'docs/**/*.md' 'docs/*.md' README.md", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const failures = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\[[^\]]*\]\(<?([^)>#\s]+)>?(?:#[^)]*)?\)/g)) {
    const target = match[1];
    if (/^[a-z]+:/.test(target)) continue; // absolute URLs and mailto
    if (target.startsWith("/")) continue; // site-absolute paths are app routes
    const resolved = join(dirname(file), decodeURIComponent(target));
    if (!existsSync(resolved)) {
      failures.push(`${file}: broken link -> ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Docs link check OK (${files.length} files)`);
