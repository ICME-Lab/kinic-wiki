import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const sourcePath = new URL("../lib/paths.ts", import.meta.url);
const source = readFileSync(sourcePath, "utf8");
const browserSource = readFileSync(new URL("../components/wiki-browser.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { hrefForDatabaseSwitch, hrefForGraph, hrefForMarkdownLink, hrefForPath, hrefForSearch, pathFromSegments } = await import(moduleUrl);

assert.equal(pathFromSegments([]), "/Wiki");
assert.equal(pathFromSegments(["Wiki", "100%.md"]), "/Wiki/100%.md");
assert.equal(
  hrefForPath("t63gs-up777-77776-aaaba-cai", "alpha", "/Wiki/100%.md"),
  "/alpha/Wiki/100%25.md"
);
assert.equal(
  hrefForPath("t63gs-up777-77776-aaaba-cai", "alpha", "/Wiki/space name.md", "raw"),
  "/alpha/Wiki/space%20name.md?view=raw"
);
assert.equal(
  hrefForPath("t63gs-up777-77776-aaaba-cai", "alpha", "/Wiki/space name.md", "edit"),
  "/alpha/Wiki/space%20name.md?view=edit"
);
assert.equal(
  hrefForPath("t63gs-up777-77776-aaaba-cai", "alpha", "/Wiki", undefined, "recent", undefined, undefined, "anonymous"),
  "/alpha/Wiki?tab=recent&read=anonymous"
);
assert.equal(
  hrefForSearch("t63gs-up777-77776-aaaba-cai", "alpha", "", "path"),
  "/alpha/search?kind=path"
);
assert.equal(
  hrefForSearch("t63gs-up777-77776-aaaba-cai", "alpha", "alpha beta", "path"),
  "/alpha/search?q=alpha+beta&kind=path"
);
assert.equal(
  hrefForSearch("t63gs-up777-77776-aaaba-cai", "alpha", "alpha beta", "full"),
  "/alpha/search?q=alpha+beta&kind=full"
);
assert.equal(
  hrefForSearch("t63gs-up777-77776-aaaba-cai", "alpha", "alpha beta", "path", "anonymous"),
  "/alpha/search?q=alpha+beta&kind=path&read=anonymous"
);
assert.equal(
  hrefForGraph("t63gs-up777-77776-aaaba-cai", "alpha", "/Wiki/index.md", 2, "anonymous"),
  "/alpha/graph?center=%2FWiki%2Findex.md&depth=2&read=anonymous"
);
assert.equal(
  hrefForDatabaseSwitch("t63gs-up777-77776-aaaba-cai", "beta", {
    isSearchPage: false,
    isGraphPage: false,
    query: "ignored",
    searchKind: "full",
    graphDepth: 2,
    readMode: null
  }),
  "/beta/Wiki"
);
assert.equal(
  hrefForDatabaseSwitch("t63gs-up777-77776-aaaba-cai", "beta", {
    isSearchPage: true,
    isGraphPage: false,
    query: "alpha beta",
    searchKind: "full",
    graphDepth: 1,
    readMode: "anonymous"
  }),
  "/beta/search?q=alpha+beta&kind=full&read=anonymous"
);
assert.equal(
  hrefForDatabaseSwitch("t63gs-up777-77776-aaaba-cai", "beta", {
    isSearchPage: false,
    isGraphPage: true,
    query: "",
    searchKind: "path",
    graphDepth: 2,
    readMode: "anonymous"
  }),
  "/beta/graph?center=%2FWiki&depth=2&read=anonymous"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Wiki/beam-full-reset/7/index.md", "facts.md"),
  "/alpha/Wiki/beam-full-reset/7/facts.md"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Wiki/beam-full-reset/7/index.md", "facts.md", "anonymous"),
  "/alpha/Wiki/beam-full-reset/7/facts.md?read=anonymous"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Wiki/beam-full-reset/7/index.md", "facts.md?view=raw#evidence", "anonymous"),
  "/alpha/Wiki/beam-full-reset/7/facts.md?view=raw&read=anonymous#evidence"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Wiki/beam-full-reset/7/index.md", "/Wiki/demo.md#evidence"),
  "/alpha/Wiki/demo.md#evidence"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Wiki/beam-full-reset/7/index.md", "/Wiki/demo.md#evidence", "anonymous"),
  "/alpha/Wiki/demo.md?read=anonymous#evidence"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Wiki/demo/index.md", "https://example.com"),
  null
);
assert.match(browserSource, /NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID/);
assert.match(browserSource, /pathname === `\/\$\{encodeURIComponent\(databaseId\)\}\/search`/);

console.log(`Path helpers OK: ${pathToFileURL(sourcePath.pathname).pathname}`);
