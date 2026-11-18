// Local security backport contract, exercised through the actual installed consumers.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const web = createRequire(new URL("../wikibrowser/package.json", import.meta.url));
function dependency(parent, name) {
  return realpathSync(createRequire(parent).resolve(name));
}
const vite = web.resolve("vite/package.json");
const tailwind = web.resolve("tailwindcss/package.json");
const consumers = [
  ["Vite", dependency(vite, "picomatch")],
  ["Vitest", dependency(web.resolve("vitest/package.json"), "picomatch")],
  ["Tailwind/micromatch", dependency(dependency(tailwind, "micromatch"), "picomatch")],
  ["Tailwind/chokidar/anymatch", dependency(dependency(dependency(tailwind, "chokidar"), "anymatch"), "picomatch")],
  ["Tailwind/chokidar/readdirp", dependency(dependency(dependency(tailwind, "chokidar"), "readdirp"), "picomatch")],
];

test("every locked picomatch copy uses a reviewed local patch", () => {
  const snapshots = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8").split("\nsnapshots:\n")[1];
  assert.ok(snapshots, "dependency snapshots must exist");
  const expected = new Set(["2.3.2", "4.0.7"].map(version => {
    const patch = readFileSync(new URL(`../patches/picomatch@${version}.patch`, import.meta.url));
    return `${version}(patch_hash=${createHash("sha256").update(patch).digest("hex")})`;
  }));
  const copies = [...snapshots.matchAll(/^  picomatch@([^:]+):/gm)].map(match => match[1]);
  assert.deepEqual(new Set(copies), expected);
  for (const match of snapshots.matchAll(/^      picomatch: (.+)$/gm)) {
    assert.ok(expected.has(match[1]), `unreviewed picomatch dependency: ${match[1]}`);
  }
});

for (const [consumer, path] of consumers) {
  test(`${consumer}: single-branch repeated wildcards cannot block the event loop`, () => {
    const result = spawnSync(process.execPath, ["-e", `
      const assert = require('node:assert/strict');
      const pm = require(process.argv[1]);
      const cases = ['+(*a)', '*(*a)', '+(*).ts', '*(a*)b', '+(@(*a))', '+(@(*(a)))', '+([[]*a)'].map(pattern => [pattern, 'a']);
      cases.push(['+([[:bogus:]*a])', 'ba]']);
      for (const [pattern, repeated] of cases) {
        assert.equal(pm.makeRe(pattern).test(repeated.repeat(40) + '!'), false, pattern);
        assert.equal(pm.isMatch(pattern, pattern), true, 'unsafe extglob must become literal: ' + pattern);
      }
    `, path], { encoding: "utf8", timeout: 2000 });
    assert.equal(result.error, undefined, `${consumer}: ${result.error?.message}`);
    assert.equal(result.status, 0, result.stderr);
  });

  test(`${consumer}: normal glob and bounded extglob behavior remains available`, () => {
    const { version } = JSON.parse(readFileSync(join(dirname(path), "package.json"), "utf8"));
    const patch = readFileSync(new URL(`../patches/picomatch@${version}.patch`, import.meta.url));
    const hash = createHash("sha256").update(patch).digest("hex");
    assert.ok(path.includes(hash), `${consumer}: installed copy must match the locked patch hash`);
    const pm = createRequire(import.meta.url)(path);
    for (const [value, pattern, options, expected] of [
      ["src/nested/a.test.ts", "**/*.test.ts", {}, true],
      ["src/a.js", "**/*.test.ts", {}, false],
      ["src/a.tsx", "src/*.{ts,tsx}", {}, true],
      ["src/a.ts", "!**/*.test.ts", {}, true],
      ["src/a.test.ts", "!**/*.test.ts", {}, false],
      ["ababa", "+(a|b)", {}, true],
      ["abab", "+(ab)", {}, true],
      ["a", "?(a|b)", {}, true],
      ["aaa", "@(a|b)", {}, false],
      ["ab", "+(?)", {}, false],
      ["***", "+([*])", {}, true],
      ["abc", "+([[:alpha:]*a])", {}, true],
      ["***", '+("*")', {}, true],
      ["***", "+(\\*)", {}, true],
      ["aaa", "+(*(a))", {}, true],
      ["src\\a.ts", "src/*.ts", { windows: true }, true],
      [".hidden.ts", "*.ts", { dot: true }, true],
      [".hidden.ts", "*.ts", {}, false],
    ]) assert.equal(pm.isMatch(value, pattern, options), expected, `${value} / ${pattern}`);
  });
}
