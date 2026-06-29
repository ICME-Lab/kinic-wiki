import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const sourcePath = new URL("../lib/paths.ts", import.meta.url);
const shareLinksSource = readFileSync(new URL("../lib/share-links.ts", import.meta.url), "utf8");
const source = `${shareLinksSource}\n${readFileSync(sourcePath, "utf8").replace('import { databaseRouteBase } from "./share-links";', "")}`;
const browserSource = readFileSync(new URL("../components/wiki-browser.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { hrefForDatabaseSwitch, hrefForGraph, hrefForHelp, hrefForMarkdownLink, hrefForPath, hrefForSearch, parseWikiRoute, pathFromSegments } = await import(moduleUrl);

assert.equal(pathFromSegments([]), "/Knowledge");
assert.equal(pathFromSegments(["Knowledge", "100%.md"]), "/Knowledge/100%.md");
assert.deepEqual(parseWikiRoute("/db/db_1"), { databaseId: "db_1", nodePath: "/Knowledge" });
assert.deepEqual(parseWikiRoute("/db/db_1/Wiki"), { databaseId: "db_1", nodePath: "/Wiki" });
assert.deepEqual(parseWikiRoute("/db/db_1/Wiki/page.md"), { databaseId: "db_1", nodePath: "/Wiki/page.md" });
assert.deepEqual(parseWikiRoute("/db/db%201/Wiki/space%20name.md"), { databaseId: "db 1", nodePath: "/Wiki/space name.md" });
assert.equal(
  hrefForPath("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/100%.md"),
  "/db/alpha/Knowledge/100%25.md"
);
assert.equal(
  hrefForPath("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/space name.md", "raw"),
  "/db/alpha/Knowledge/space%20name.md?view=raw"
);
assert.equal(
  hrefForPath("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/space name.md", "edit"),
  "/db/alpha/Knowledge/space%20name.md?view=edit"
);
assert.equal(
  hrefForPath("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge", undefined, "query"),
  "/db/alpha/Knowledge?tab=query"
);
assert.equal(
  hrefForPath("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/conversations/日本語記事.md"),
  "/db/alpha/Knowledge/conversations/%E6%97%A5%E6%9C%AC%E8%AA%9E%E8%A8%98%E4%BA%8B.md"
);
assert.equal(
  hrefForSearch("t63gs-up777-77776-aaaba-cai", "alpha", "", "path"),
  "/db/alpha/search?kind=path"
);
assert.equal(
  hrefForSearch("t63gs-up777-77776-aaaba-cai", "alpha", "alpha beta", "path"),
  "/db/alpha/search?q=alpha+beta&kind=path"
);
assert.equal(
  hrefForSearch("t63gs-up777-77776-aaaba-cai", "alpha", "alpha beta", "full"),
  "/db/alpha/search?q=alpha+beta&kind=full"
);
assert.equal(
  hrefForSearch("t63gs-up777-77776-aaaba-cai", "alpha", "alpha beta", "full", {
    scope: "sources",
    limit: 50,
    preview: "content-start"
  }),
  "/db/alpha/search?q=alpha+beta&kind=full&scope=sources&limit=50&preview=content-start"
);
assert.equal(
  hrefForSearch("t63gs-up777-77776-aaaba-cai", "alpha", "alpha beta", "path", {
    scope: "custom",
    prefix: "/Knowledge/project notes",
    limit: 100,
    preview: "none"
  }),
  "/db/alpha/search?q=alpha+beta&kind=path&scope=custom&prefix=%2FKnowledge%2Fproject+notes&limit=100&preview=none"
);
assert.equal(
  hrefForGraph("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/index.md", 2),
  "/db/alpha/graph?center=%2FKnowledge%2Findex.md&depth=2"
);
assert.equal(
  hrefForHelp("t63gs-up777-77776-aaaba-cai", "alpha"),
  "/db/alpha/help"
);
assert.equal(
  hrefForDatabaseSwitch("t63gs-up777-77776-aaaba-cai", "beta", {
    isSearchPage: false,
    isGraphPage: false,
    query: "ignored",
    searchKind: "full",
    graphDepth: 2
  }),
  "/db/beta/Knowledge"
);
assert.equal(
  hrefForDatabaseSwitch("t63gs-up777-77776-aaaba-cai", "beta", {
    isSearchPage: true,
    isGraphPage: false,
    query: "alpha beta",
    searchKind: "full",
    searchOptions: { scope: "sources", limit: 50, preview: "light" },
    graphDepth: 1
  }),
  "/db/beta/search?q=alpha+beta&kind=full&scope=sources&limit=50&preview=light"
);
assert.equal(
  hrefForDatabaseSwitch("t63gs-up777-77776-aaaba-cai", "beta", {
    isSearchPage: false,
    isGraphPage: true,
    query: "",
    searchKind: "path",
    graphDepth: 2
  }),
  "/db/beta/graph?center=%2FKnowledge&depth=2"
);
assert.equal(
  hrefForDatabaseSwitch("t63gs-up777-77776-aaaba-cai", "beta", {
    isHelpPage: true,
    isSearchPage: false,
    isGraphPage: false,
    query: "",
    searchKind: "path",
    graphDepth: 1
  }),
  "/db/beta/help"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/beam-full-reset/7/index.md", "facts.md"),
  "/db/alpha/Knowledge/beam-full-reset/7/facts.md"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/beam-full-reset/7/index.md", "facts.md?view=raw#evidence"),
  "/db/alpha/Knowledge/beam-full-reset/7/facts.md?view=raw#evidence"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/beam-full-reset/7/index.md", "facts.md?view=raw&tab=query#evidence"),
  "/db/alpha/Knowledge/beam-full-reset/7/facts.md?view=raw&tab=query#evidence"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/beam-full-reset/7/index.md", "/Knowledge/demo.md#evidence"),
  "/db/alpha/Knowledge/demo.md#evidence"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/index.md", "/Knowledge/space name.md"),
  "/db/alpha/Knowledge/space%20name.md"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/index.md", "/Knowledge/100%25.md"),
  "/db/alpha/Knowledge/100%25.md"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/index.md", "/Knowledge/a%23b.md"),
  "/db/alpha/Knowledge/a%23b.md"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/index.md", "/Knowledge/a%3Fb.md"),
  "/db/alpha/Knowledge/a%3Fb.md"
);
assert.equal(
  hrefForMarkdownLink("t63gs-up777-77776-aaaba-cai", "alpha", "/Knowledge/demo/index.md", "https://example.com"),
  null
);
assert.match(browserSource, /NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID/);
assert.match(browserSource, /pathname === `\$\{databaseRouteBase\(databaseId\)\}\/search`/);
assert.match(browserSource, /pathname === `\$\{databaseRouteBase\(databaseId\)\}\/help`/);

console.log(`Path helpers OK: ${pathToFileURL(sourcePath.pathname).pathname}`);
