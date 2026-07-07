import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const frontmatterPath = new URL("../lib/markdown-frontmatter.ts", import.meta.url);
const seoPath = new URL("../lib/wiki-seo.ts", import.meta.url);
const source = `${readFileSync(frontmatterPath, "utf8")}\n${readFileSync(seoPath, "utf8")
  .replace('import { splitMarkdownFrontmatter } from "@/lib/markdown-frontmatter";', "")
  .replace('import type { ChildNode, DatabaseSummary, WikiNode } from "@/lib/types";', "")}`;
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { descriptionFromNode, markdownBody, titleFromNode, titleFromPath, wikiSeoDescription, wikiSeoRouteFromSegments, wikiSeoTitle } = await import(moduleUrl);

const node = {
  path: "/Knowledge/product-roadmap.md",
  kind: "file",
  content: `---\ntitle: Product Roadmap\ndescription: Public roadmap notes for Kinic Wiki discovery.\n---\n# Ignored Heading\n\nBody text.`,
  createdAt: "0",
  updatedAt: "0",
  etag: "etag",
  metadataJson: "{}"
};

assert.deepEqual(wikiSeoRouteFromSegments(undefined), { indexable: true, nodePath: "/Knowledge" });
assert.deepEqual(wikiSeoRouteFromSegments(["search"]), { indexable: false, nodePath: "/search" });
assert.equal(titleFromNode(node), "Product Roadmap");
assert.equal(descriptionFromNode(node), "Public roadmap notes for Kinic Wiki discovery.");
assert.equal(markdownBody(node.content), "# Ignored Heading\n\nBody text.");
assert.equal(titleFromPath("/Knowledge/source-capture/index.md"), "index");
assert.equal(
  wikiSeoTitle("Demo DB", "/Knowledge/source-capture", { ...node, path: "/Knowledge/source-capture/index.md", content: "" }),
  "source capture - Demo DB"
);
assert.equal(
  wikiSeoDescription(null, null, [
    { path: "/Knowledge/a.md", name: "a.md", kind: "file", updatedAt: null, etag: null, sizeBytes: null, isVirtual: false, hasChildren: false },
    { path: "/Knowledge/b.md", name: "b.md", kind: "file", updatedAt: null, etag: null, sizeBytes: null, isVirtual: false, hasChildren: false }
  ]),
  "Browse a.md, b.md in this Kinic Wiki folder."
);

console.log(`SEO helpers OK: ${pathToFileURL(seoPath.pathname).pathname}`);
