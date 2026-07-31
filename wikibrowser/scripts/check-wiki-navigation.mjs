import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const navigationSource = readFileSync(new URL("../components/wiki-navigation.tsx", import.meta.url), "utf8");
assert.match(navigationSource, /from "@tanstack\/react-router"/);
assert.match(navigationSource, /useBlocker\(/);
assert.match(navigationSource, /enableBeforeUnload/);
assert.doesNotMatch(navigationSource, /pushState|replaceState|popstate|stopImmediatePropagation/);

for (const relativePath of [
  "../components/wiki-browser.tsx",
  "../components/wiki-browser/top-bar.tsx",
  "../components/explorer-tree.tsx",
  "../components/document-pane.tsx",
  "../components/graph-panel.tsx",
  "../components/inspector.tsx",
  "../components/markdown-preview.tsx",
  "../components/search-panel.tsx"
]) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["']next\//, `${relativePath} must not use Next.js`);
}

console.log("TanStack wiki navigation OK");
