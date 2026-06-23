import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const { collectLintHints, provenancePathFor, rawSourceLinksFor } = await importTs("../lib/lint-hints.ts");
const { normalizeSearchHit } = await importTs("../lib/search-normalizer.ts");
const { readBrowserNodeCache } = await importTs("../lib/browser-node-cache.ts");
const { sortChildNodes } = await importTs("../lib/child-sort.ts");
const { folderIndexPath, isFolderIndexNode, isReservedFolderIndexName, visibleChildren } = await importTs("../lib/folder-index.ts");
const { cycleTone, formatCycles, formatRawCycles } = await importTs("../lib/cycles.ts");
const { splitMarkdownPreviewSections } = await importTs("../lib/markdown-sections.ts");
const { renderWikilinksAsMarkdown } = await importTs("../lib/markdown-wikilinks.ts");
const { graphRequestKey, nodeRequestKey, searchRequestKey } = await importTs("../lib/request-keys.ts");
const { hrefForMarkdownLink } = await importTs("../lib/paths.ts");
const { parseSearchOptions, prefixForSearchScope } = await importTs("../lib/search-options.ts");
const { isRoutableDatabaseId, publicDatabasePath, publicDatabaseUrl, xShareDatabaseHref } = await importTs("../lib/share-links.ts");
const { canExpandChildNode, inferNoteRole, parseModeTab, readIdentityMode } = await importTs("../lib/wiki-helpers.ts");
const { classifyQueryInput, queryAnswerSearchTerms } = await importTs("../lib/query-actions.ts");
const explorerTreeSource = readFileSync(new URL("../components/explorer-tree.tsx", import.meta.url), "utf8");
const documentPaneSource = readFileSync(new URL("../components/document-pane.tsx", import.meta.url), "utf8");
const inspectorSource = readFileSync(new URL("../components/inspector.tsx", import.meta.url), "utf8");
const layoutSource = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
const databaseLayoutSource = readFileSync(new URL("../app/db/[databaseId]/layout.tsx", import.meta.url), "utf8");
const linkPreviewImageSource = readFileSync(new URL("../app/link-preview-image.tsx", import.meta.url), "utf8");
const openGraphImageSource = readFileSync(new URL("../app/opengraph-image.tsx", import.meta.url), "utf8");
const twitterImageSource = readFileSync(new URL("../app/twitter-image.tsx", import.meta.url), "utf8");
const databaseOpenGraphImageSource = readFileSync(new URL("../app/db/[databaseId]/opengraph-image.tsx", import.meta.url), "utf8");
const databaseTwitterImageSource = readFileSync(new URL("../app/db/[databaseId]/twitter-image.tsx", import.meta.url), "utf8");
const markdownEditDocumentSource = readFileSync(new URL("../components/markdown-edit-document.tsx", import.meta.url), "utf8");
const markdownEditorSource = readFileSync(new URL("../components/markdown-editor.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../components/panel.tsx", import.meta.url), "utf8");
const searchPanelSource = readFileSync(new URL("../components/search-panel.tsx", import.meta.url), "utf8");
const wikiBrowserSource = readFileSync(new URL("../components/wiki-browser.tsx", import.meta.url), "utf8");
const queryPanelSource = readFileSync(new URL("../components/query-panel.tsx", import.meta.url), "utf8");
const memoryRecallSource = readFileSync(new URL("../lib/query-context.ts", import.meta.url), "utf8");
const vfsClientSource = readFileSync(new URL("../lib/vfs-client.ts", import.meta.url), "utf8");
const databasePreviewSource = readFileSync(new URL("../lib/database-preview.ts", import.meta.url), "utf8");
const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const tailwindConfig = readFileSync(new URL("../tailwind.config.ts", import.meta.url), "utf8");

assert.match(explorerTreeSource, /childNodesCache\.current\.get\(requestKey\)/);
assert.match(explorerTreeSource, /childNodesCache\.current\.set\(requestKey, data\)/);
assert.match(explorerTreeSource, /visibleChildren\(childrenState\.data\)/);
assert.match(explorerTreeSource, /key=\{`\$\{canisterId\}:\$\{databaseId\}:\/Wiki:/);
assert.match(explorerTreeSource, /onSelectedNode/);
assert.doesNotMatch(explorerTreeSource, /onCreateMarkdownFile/);
assert.doesNotMatch(explorerTreeSource, /onDeleteMarkdownNode/);
assert.doesNotMatch(explorerTreeSource, /group-hover:opacity-100/);
assert.doesNotMatch(explorerTreeSource, /New Markdown under/);
assert.match(panelSource, /actions\?: ReactNode/);
assert.match(panelSource, /\{actions \? <div className="shrink-0">\{actions\}<\/div> : null\}/);
assert.match(wikiBrowserSource, /data-tid="header-login-button"/);
assert.match(wikiBrowserSource, /onClick=\{onLogin\}/);
assert.match(wikiBrowserSource, /src="\/kinic-mark\.png"/);
assert.doesNotMatch(wikiBrowserSource, /src="\/icon\.png"/);
assert.doesNotMatch(wikiBrowserSource, /LayoutDashboard/);
assert.match(wikiBrowserSource, /aria-label="Back to database dashboard"/);
assert.match(wikiBrowserSource, /lg:grid-cols-\[auto_minmax\(280px,720px\)_auto\]/);
assert.match(wikiBrowserSource, /lg:col-start-2 lg:row-start-1/);
assert.match(wikiBrowserSource, /lg:col-start-3 lg:row-start-1 lg:justify-end/);
assert.match(wikiBrowserSource, /HEADER_ICON_LINK_CLASS = "inline-flex h-9 items-center justify-center gap-1 rounded-lg border px-3 text-sm no-underline"/);
assert.match(wikiBrowserSource, /const graphHref = isGraphPage[\s\S]*hrefForPath\(canisterId, databaseId, graphLinkCenter \?\? "\/Wiki"/);
assert.match(wikiBrowserSource, /<Network size=\{18\} aria-hidden \/>/);
assert.match(wikiBrowserSource, /<Share2 aria-hidden size=\{18\} \/>/);
assert.match(wikiBrowserSource, /sr-only sm:not-sr-only/);
assert.match(wikiBrowserSource, /Share2/);
assert.match(wikiBrowserSource, /xShareDatabaseHref/);
assert.match(wikiBrowserSource, /\{publicReadable \? \(\s*<a[\s\S]*xShareDatabaseHref\(\{ databaseId, databaseName: currentDatabaseName \}\)[\s\S]*title="Share on X"[\s\S]*<\/a>\s*\) : null\}/);
assert.doesNotMatch(wikiBrowserSource, /hidden items-center gap-1 rounded-lg border border-line[\s\S]*md:flex/);
assert.match(wikiBrowserSource, /value === "edit"/);
assert.match(wikiBrowserSource, /canLeaveDirtyEdit/);
assert.match(wikiBrowserSource, /UNSAVED_MARKDOWN_MESSAGE/);
assert.match(wikiBrowserSource, /deleteNodeAuthenticated/);
assert.match(wikiBrowserSource, /writeNodeAuthenticated/);
assert.match(wikiBrowserSource, /mkdirNodeAuthenticated/);
assert.match(wikiBrowserSource, /moveNodeAuthenticated/);
assert.match(wikiBrowserSource, /nodeContextCache\.current\.clear\(\)/);
assert.match(wikiBrowserSource, /childNodesCache\.current\.clear\(\)/);
assert.match(wikiBrowserSource, /expectedEtag: null/);
assert.match(wikiBrowserSource, /folderIndexPath\(selectedPath\)/);
assert.match(wikiBrowserSource, /Use folder Edit to create index\.md\./);
assert.match(wikiBrowserSource, /const \{ deleteNodeAuthenticated, readNode \} = await import\("@\/lib\/vfs-client"\)/);
assert.match(wikiBrowserSource, /readNode\(canisterId, databaseId, folderIndexPath\(target\.path\), readIdentity\)/);
assert.doesNotMatch(wikiBrowserSource, /path: indexNode\.path/);
assert.match(wikiBrowserSource, /expectedFolderIndexEtag: indexNode\?\.etag \?\? null/);
assert.doesNotMatch(wikiBrowserSource, /currentFolderIndexNode\.data\?\.path === folderIndexPath\(target\.path\)/);
assert.match(wikiBrowserSource, /memberDatabases\.find/);
assert.match(wikiBrowserSource, /SIDEBAR_TABS: ModeTab\[\] = \["explorer", "query", "ingest", "clipper"\]/);
assert.match(wikiBrowserSource, /publicDatabaseIds/);
assert.match(wikiBrowserSource, /databaseName=\{currentDatabase\?\.name \?\? databaseId\}/);
assert.match(inspectorSource, /databaseName: string/);
assert.match(inspectorSource, /label="database"/);
assert.match(inspectorSource, /label="database_id"/);
assert.match(inspectorSource, /label="created_at"/);
assert.match(inspectorSource, /label="metadata_json"/);
assert.match(layoutSource, /title: "Kinic Wiki AI Memory"/);
assert.match(layoutSource, /description: "Use Kinic Wiki as canister-backed AI memory through kinic-vfs-cli, with browser tools for browsing and management\."/);
assert.match(layoutSource, /metadataBase: new URL\("https:\/\/wiki\.kinic\.xyz"\)/);
assert.match(layoutSource, /openGraph:/);
assert.match(layoutSource, /twitter:/);
assert.match(layoutSource, /card: "summary_large_image"/);
assert.doesNotMatch(layoutSource, /Read-only browser|Wiki Canister Browser/);
assert.match(linkPreviewImageSource, /ImageResponse/);
assert.doesNotMatch(linkPreviewImageSource, /readFile|node:fs/);
assert.match(linkPreviewImageSource, /KinicPreviewMark/);
assert.doesNotMatch(linkPreviewImageSource, />\s*K\s*<\/div>/);
assert.match(linkPreviewImageSource, /width: 1200/);
assert.match(linkPreviewImageSource, /height: 630/);
assert.match(linkPreviewImageSource, /Kinic Wiki/);
assert.match(openGraphImageSource, /renderLinkPreviewImage/);
assert.match(twitterImageSource, /renderLinkPreviewImage/);
assert.match(databaseLayoutSource, /generateMetadata/);
assert.match(databaseLayoutSource, /loadDatabasePreview/);
assert.match(databaseLayoutSource, /databasePreviewTitle/);
assert.match(databaseLayoutSource, /opengraph-image/);
assert.match(databaseLayoutSource, /twitter-image/);
assert.match(databaseOpenGraphImageSource, /Kinic Wiki database/);
assert.doesNotMatch(databaseOpenGraphImageSource, /isReservedDatabaseRouteSlug|notFound\(\)/);
assert.match(databaseOpenGraphImageSource, /preview\.databaseName/);
assert.match(databaseTwitterImageSource, /Kinic Wiki database/);
assert.doesNotMatch(databaseTwitterImageSource, /isReservedDatabaseRouteSlug|notFound\(\)/);
assert.match(databaseTwitterImageSource, /preview\.databaseName/);
assert.match(databasePreviewSource, /databasePreviewTitle/);
assert.match(databasePreviewSource, /databasePreviewDescription/);
assert.match(databasePreviewSource, /listDatabasesPublic/);
assert.match(queryPanelSource, /authorizeQueryAnswerSession/);
assert.match(queryPanelSource, /Login with Internet Identity to ask wiki questions/);
assert.match(queryPanelSource, /sessionNonce/);
assert.match(queryPanelSource, /2_000/);
assert.match(queryPanelSource, /htmlFor="query-command">Query/);
assert.match(queryPanelSource, /LLM answer/);
assert.doesNotMatch(queryPanelSource, /Search by default/);
assert.match(queryPanelSource, /non-LLM/);
assert.match(queryPanelSource, /read-only/);
assert.match(searchPanelSource, /Custom prefix/);
assert.match(searchPanelSource, /onCustomPrefixCommit/);
assert.match(searchPanelSource, /searchOptions\.limit/);
assert.match(searchPanelSource, /searchOptions\.preview/);
assert.match(vfsClientSource, /preview_mode: searchPreviewModeArg\(previewMode\)/);
assert.match(memoryRecallSource, /isAnswerContextNode\(input\.currentNode\)/);
assert.match(memoryRecallSource, /queryAnswerSearchTerms\(input\.question\)/);
assert.match(memoryRecallSource, /readNodeContext\(input\.canisterId, input\.databaseId, hit\.path, 5/);
assert.match(memoryRecallSource, /node\.kind === "file" \|\| node\.kind === "source"/);
assert.match(wikiBrowserSource, /ExplorerHeaderActions/);
assert.match(wikiBrowserSource, /ExplorerCreateForm/);
assert.match(wikiBrowserSource, /ExplorerMoveForm/);
assert.match(wikiBrowserSource, /FolderPlus/);
assert.match(wikiBrowserSource, /Pencil/);
assert.match(wikiBrowserSource, /MoveRight/);
assert.match(wikiBrowserSource, /normalizeMarkdownFileName/);
assert.match(wikiBrowserSource, /normalizePathSegment/);
assert.match(wikiBrowserSource, /trimmed\.endsWith\("\.md"\) \? trimmed : `\$\{trimmed\}\.md`/);
assert.match(wikiBrowserSource, /createDirectoryForExplorerNode/);
assert.match(wikiBrowserSource, /currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner"/);
assert.match(wikiBrowserSource, /isMutableWikiExplorerNode/);
assert.match(wikiBrowserSource, /isProtectedRootFolder\(node\.path\)/);
assert.match(wikiBrowserSource, /path === "\/Wiki" \|\| path === "\/Sources"/);
assert.match(wikiBrowserSource, /node\.kind === "folder"/);
assert.match(wikiBrowserSource, /visibleChildren\(loadedChildren, node\.path\)\.length === 0/);
assert.match(wikiBrowserSource, /: !node\.hasChildren/);
assert.doesNotMatch(wikiBrowserSource, /DocumentBreadcrumbs/);
assert.doesNotMatch(wikiBrowserSource, /readMode/);
assert.match(documentPaneSource, /DocumentHeaderPath/);
assert.match(documentPaneSource, /Current wiki path/);
assert.match(documentPaneSource, /h-10 w-fit min-w-0 max-w-full/);
assert.match(documentPaneSource, /hrefForPath\(canisterId, databaseId, crumbPath/);
assert.match(documentPaneSource, /label="Edit"/);
assert.match(documentPaneSource, /Copy path/);
assert.match(documentPaneSource, /Copy raw/);
assert.doesNotMatch(documentPaneSource, /isDirectory \? "directory" : "node"/);
assert.doesNotMatch(documentPaneSource, /displayPath/);
assert.match(documentPaneSource, /navigator\.clipboard\.writeText/);
assert.match(documentPaneSource, /node\.data\?\.kind === "folder"/);
assert.match(documentPaneSource, /FolderIndexSection/);
assert.match(documentPaneSource, /emptyFolderIndexNode/);
assert.match(documentPaneSource, /node\.kind === "file" && node\.path\.endsWith\("\.md"\) && !node\.path\.startsWith\("\/Sources\/raw\/"\)/);
assert.doesNotMatch(documentPaneSource, /readMode/);
assert.doesNotMatch(documentPaneSource, /Authenticated mode required/);
assert.doesNotMatch(documentPaneSource, /Use authenticated mode/);
assert.match(documentPaneSource, /Writer or owner access required/);
assert.match(documentPaneSource, /Database role unavailable/);
assert.match(markdownEditDocumentSource, /writeNodeAuthenticated/);
assert.match(markdownEditDocumentSource, /expectedEtag: editor\.baseEtag/);
assert.match(markdownEditDocumentSource, /result\.node\.etag/);
assert.match(markdownEditDocumentSource, /Saved, but refresh failed/);
assert.match(markdownEditDocumentSource, /saveWarning/);
assert.match(markdownEditorSource, /saveState === "dirty" \|\| saveState === "error"/);
assert.match(markdownEditorSource, /warning: string \| null/);
assert.match(vfsClientSource, /deleteNodeAuthenticated/);
assert.match(vfsClientSource, /delete_node/);
assert.match(vfsClientSource, /wikiMetricsSeries/);
assert.match(vfsClientSource, /wiki_metrics_series/);
assert.match(vfsClientSource, /normalizeWikiMetricsPoint/);
assert.match(markdownEditorSource, /@uiw\/react-codemirror/);
assert.match(markdownEditorSource, /Cmd\/Ctrl\+S|Save/);
assert.match(globalsCss, /button:not\(:disabled\):active/);
assert.match(globalsCss, /transform: translateY\(-1px\)/);
assert.match(globalsCss, /button\[aria-busy="true"\]/);
assert.match(globalsCss, /prefers-reduced-motion/);
assert.match(tailwindConfig, /accent: "#ff2686"/);
assert.match(tailwindConfig, /action: "#000000"/);
assert.match(tailwindConfig, /paper: "#f8f8f8"/);
assert.doesNotMatch(tailwindConfig, /#1f6feb|#7c3aed|#6d28d9|#f6f1e8|#fffdf8|#ded7cb/);
assert.doesNotMatch(globalsCss, /#1f6feb|#7c3aed|#6d28d9|#f6f1e8|#efe7d8|#ded7cb/);

const factsHints = collectLintHints("/Wiki/demo/facts.md", "Deadline is May 10.\nStable value is blue.");
assert.equal(factsHints.length, 1);
assert.equal(factsHints[0].title, "Possible future or pending item");
assert.equal(factsHints[0].preview, "Deadline is May 10.");

const summaryHints = collectLintHints("/Wiki/demo/summary.md", "Receipt AB-123456 was filed.");
assert.equal(summaryHints.length, 1);
assert.equal(summaryHints[0].title, "Possible exact evidence leak");

const codeHints = collectLintHints("/Wiki/demo/code-note.md", "- Implementation: `crates/vfs_store/src/fs_store.rs`");
assert.equal(codeHints.length, 1);
assert.equal(codeHints[0].title, "Code note lacks decision context");
assert.equal(codeHints[0].preview, "- Implementation: `crates/vfs_store/src/fs_store.rs`");

assert.deepEqual(
  rawSourceLinksFor("/Wiki/demo/provenance.md", "- Raw: /Sources/raw/demo/source.md\n- Raw: /Sources/raw/demo/source.md"),
  ["/Sources/raw/demo/source.md"]
);
assert.deepEqual(
  rawSourceLinksFor("/Sources/raw/demo/source.md", "# Raw"),
  ["/Sources/raw/demo/source.md"]
);

assert.deepEqual(parseSearchOptions(new URLSearchParams("")), {
  scope: "wiki",
  prefix: "/Wiki",
  limit: 20,
  preview: "default"
});
assert.deepEqual(parseSearchOptions(new URLSearchParams("scope=sources&limit=50&preview=content-start")), {
  scope: "sources",
  prefix: "/Sources",
  limit: 50,
  preview: "content-start"
});
assert.deepEqual(parseSearchOptions(new URLSearchParams("scope=custom&prefix=Wiki/project&limit=100&preview=none")), {
  scope: "custom",
  prefix: "/Wiki/project",
  limit: 100,
  preview: "none"
});
assert.deepEqual(parseSearchOptions(new URLSearchParams("scope=custom&prefix=&limit=999&preview=semantic")), {
  scope: "custom",
  prefix: "/Wiki",
  limit: 20,
  preview: "default"
});
assert.equal(prefixForSearchScope("root", "/ignored"), "/");
assert.equal(provenancePathFor("/Wiki/demo/facts.md"), "/Wiki/demo/provenance.md");
assert.equal(provenancePathFor("/Wiki/demo/provenance.md"), null);

const sortedChildren = sortChildNodes([
  child("/Wiki/10.md", "10.md", "file"),
  child("/Wiki/2.md", "2.md", "file"),
  child("/Wiki/beta", "beta", "folder"),
  child("/Wiki/1.md", "1.md", "file"),
  child("/Wiki/alpha", "alpha", "folder")
]);
assert.deepEqual(
  sortedChildren.map((node) => node.path),
  ["/Wiki/alpha", "/Wiki/beta", "/Wiki/1.md", "/Wiki/2.md", "/Wiki/10.md"]
);
assert.equal(folderIndexPath("/Wiki/project"), "/Wiki/project/index.md");
assert.equal(folderIndexPath("/Wiki/project/"), "/Wiki/project/index.md");
assert.equal(isFolderIndexNode(child("/Wiki/project/index.md", "index.md", "file"), "/Wiki/project"), true);
assert.equal(isFolderIndexNode(child("/Wiki/project/note.md", "note.md", "file"), "/Wiki/project"), false);
assert.equal(isReservedFolderIndexName("INDEX.md"), true);
assert.deepEqual(
  visibleChildren([
    child("/Wiki/project/index.md", "index.md", "file"),
    child("/Wiki/project/note.md", "note.md", "file")
  ], "/Wiki/project").map((node) => node.path),
  ["/Wiki/project/note.md"]
);
assert.deepEqual(
  visibleChildren([
    child("/Wiki/project/index.md", "index.md", "file")
  ], "/Wiki/project").map((node) => node.path),
  []
);
assert.equal(canExpandChildNode(child("/Wiki/file-parent", "file-parent", "file", true)), true);
assert.equal(canExpandChildNode(child("/Wiki/file-leaf.md", "file-leaf.md", "file", false)), false);
assert.equal(canExpandChildNode(child("/Wiki/folder", "folder", "folder", false)), true);
assert.equal(parseModeTab("query"), "query");
assert.equal(parseModeTab("sources"), "explorer");
assert.deepEqual(queryAnswerSearchTerms("vetkeyについて教えて"), ["vetkey"]);
assert.deepEqual(queryAnswerSearchTerms("What does the wiki say about vetKey?"), ["vetKey"]);
assert.equal(parseModeTab("legacy"), "explorer");
assert.equal(readIdentityMode(true, true, true, true), "user");
assert.equal(readIdentityMode(true, true, true, false), "user");
assert.equal(readIdentityMode(true, false, true, true), "anonymous");
assert.equal(readIdentityMode(true, false, false, true), "anonymous");
assert.equal(readIdentityMode(true, false, false, false), "user");
assert.equal(readIdentityMode(false, false, false, true), "anonymous");
assert.equal(classifyQueryInput("https://example.com/a", "/Wiki", "user").kind, "queue_url");
assert.deepEqual(classifyQueryInput("sql: SELECT json_object('url', 'https://example.com/a')", "/Wiki", "anonymous"), {
  kind: "sql",
  targetPath: "current database",
  sideEffect: "none",
  identityMode: "anonymous",
  sql: "SELECT json_object('url', 'https://example.com/a')"
});
assert.deepEqual(classifyQueryInput("topic", "/Wiki", "user"), {
  kind: "search",
  targetPath: "/Wiki",
  sideEffect: "none",
  identityMode: "user",
  query: "topic"
});
assert.equal(classifyQueryInput("recent", "/Wiki", "user").kind, "search");
assert.equal(classifyQueryInput("lint facts", "/Wiki/current.md", "user").targetPath, "/Wiki/facts.md");
assert.deepEqual(classifyQueryInput("budget", "/Wiki", "anonymous"), {
  kind: "search",
  targetPath: "/Wiki",
  sideEffect: "none",
  identityMode: "anonymous",
  query: "budget"
});
assert.deepEqual(classifyQueryInput("search: budget", "/Wiki", "user"), {
  kind: "search",
  targetPath: "/Wiki",
  sideEffect: "none",
  identityMode: "user",
  query: "budget"
});
assert.deepEqual(classifyQueryInput("ask: budget status", "/Wiki", "user"), {
  kind: "ask",
  targetPath: "/Wiki",
  sideEffect: "none",
  identityMode: "user",
  question: "budget status"
});
assert.equal(classifyQueryInput("前の方針は？", "/Wiki", "user").kind, "ask");

const hit = normalizeSearchHit({
  path: "/Wiki/demo.md",
  kind: { File: null },
  snippet: ["demo snippet"],
  preview: [
    {
      field: { Content: null },
      char_offset: 42,
      match_reason: "content",
      excerpt: ["demo excerpt"]
    }
  ],
  score: 0.75,
  match_reasons: ["content"]
});
assert.deepEqual(hit, {
  path: "/Wiki/demo.md",
  kind: "file",
  snippet: "demo snippet",
  preview: {
    field: "content",
    charOffset: 42,
    matchReason: "content",
    excerpt: "demo excerpt"
  },
  score: 0.75,
  matchReasons: ["content"]
});
const folderHit = normalizeSearchHit({
  path: "/Wiki/demo",
  kind: { Folder: null },
  snippet: [],
  preview: [],
  score: 0.5,
  match_reasons: ["path"]
});
assert.equal(folderHit.kind, "folder");

assert.deepEqual(
  splitMarkdownPreviewSections("Intro\n\n# One\nBody\n## Two\nMore").map((section) => section.split("\n")[0]),
  ["Intro", "# One", "## Two"]
);
assert.deepEqual(
  splitMarkdownPreviewSections("# One\n```md\n# Not heading\n```\n## Two").map((section) => section.split("\n")[0]),
  ["# One", "## Two"]
);
assert.deepEqual(
  splitMarkdownPreviewSections("# One\n~~~md\n# Not heading\n~~~\n## Two").map((section) => section.split("\n")[0]),
  ["# One", "## Two"]
);
assert.equal(splitMarkdownPreviewSections("No headings\nOnly prose").length, 1);
assert.notEqual(nodeRequestKey("aaaaa-aa", "alpha", "/Wiki/index.md"), nodeRequestKey("bbbbb-bb", "alpha", "/Wiki/index.md"));
assert.notEqual(
  graphRequestKey("aaaaa-aa", "alpha", "/Wiki/index.md", 1),
  graphRequestKey("aaaaa-aa", "alpha", "/Wiki/index.md", 2)
);
assert.equal(graphRequestKey("aaaaa-aa", "alpha", null, 1), null);
assert.equal(searchRequestKey("aaaaa-aa", "alpha", "path", "budget"), searchRequestKey("aaaaa-aa", "alpha", "path", "budget"));
assert.notEqual(searchRequestKey("aaaaa-aa", "alpha", "path", "budget"), searchRequestKey("aaaaa-aa", "alpha", "full", "budget"));
assert.notEqual(searchRequestKey("aaaaa-aa", "alpha", "path", "budget"), searchRequestKey("aaaaa-aa", "beta", "path", "budget"));
assert.notEqual(searchRequestKey("aaaaa-aa", "alpha", "path", "budget"), searchRequestKey("bbbbb-bb", "alpha", "path", "budget"));
assert.notEqual(nodeRequestKey("aaaaa-aa", "alpha", "/Wiki/index.md"), nodeRequestKey("aaaaa-aa", "alpha", "/Wiki/index.md", "aaaaa-aa"));
assert.notEqual(
  graphRequestKey("aaaaa-aa", "alpha", "/Wiki/index.md", 1),
  graphRequestKey("aaaaa-aa", "alpha", "/Wiki/index.md", 1, "aaaaa-aa")
);
assert.notEqual(searchRequestKey("aaaaa-aa", "alpha", "path", "budget"), searchRequestKey("aaaaa-aa", "alpha", "path", "budget", "aaaaa-aa"));
assert.equal(publicDatabasePath("alpha/db"), "/db/alpha%2Fdb/Wiki");
assert.equal(publicDatabasePath("db_kva4v2twg6jv"), "/db/db_kva4v2twg6jv/Wiki");
assert.equal(publicDatabaseUrl("alpha db"), "https://wiki.kinic.xyz/db/alpha%20db/Wiki");
assert.equal(publicDatabaseUrl("alpha db", "http://127.0.0.1:3000"), "http://127.0.0.1:3000/db/alpha%20db/Wiki");
assert.equal(isRoutableDatabaseId("db_xuwmtks27uik"), true);
assert.equal(isRoutableDatabaseId("dashboard"), true);
assert.equal(isRoutableDatabaseId(""), false);
assert.throws(() => publicDatabasePath(""), /invalid database id/);
assert.equal(
  xShareDatabaseHref({ databaseId: "alpha db", databaseName: "Research DB", origin: "https://wiki.kinic.xyz" }),
  "https://twitter.com/intent/tweet?text=Kinic+Wiki%3A+Research+DB&url=https%3A%2F%2Fwiki.kinic.xyz%2Fdb%2Falpha%2520db%2FWiki"
);
assert.equal(
  renderWikilinksAsMarkdown("[[/Sources/raw/a/a.md|opencode.ai/DESIGN.md]]"),
  "[opencode.ai/DESIGN.md](</Sources/raw/a/a.md>)"
);
assert.equal(renderWikilinksAsMarkdown("[[notes/alpha.md]]"), "[notes/alpha.md](<notes/alpha.md>)");
assert.equal(renderWikilinksAsMarkdown("[[notes/alpha.md|]]"), "[notes/alpha.md](<notes/alpha.md>)");
assert.equal(renderWikilinksAsMarkdown("[[notes/alpha.md|A|B]]"), "[A\\|B](<notes/alpha.md>)");
assert.equal(renderWikilinksAsMarkdown("| [[notes/alpha.md|A|B]] |"), "| [A\\|B](<notes/alpha.md>) |");
assert.equal(renderWikilinksAsMarkdown("`[[notes/alpha.md|Alpha]]`"), "`[[notes/alpha.md|Alpha]]`");
assert.equal(renderWikilinksAsMarkdown(" [[notes/alpha.md|Alpha]]"), " [Alpha](<notes/alpha.md>)");
assert.equal(renderWikilinksAsMarkdown("    [[notes/alpha.md|Alpha]]"), "    [[notes/alpha.md|Alpha]]");
assert.equal(renderWikilinksAsMarkdown("\t[[notes/alpha.md|Alpha]]"), "\t[[notes/alpha.md|Alpha]]");
assert.equal(
  renderWikilinksAsMarkdown("before [[notes/a.md|A]] `[[notes/b.md|B]]` after [[notes/c.md|C]]"),
  "before [A](<notes/a.md>) `[[notes/b.md|B]]` after [C](<notes/c.md>)"
);
assert.equal(renderWikilinksAsMarkdown("[[notes/alpha.md"), "[[notes/alpha.md");
assert.equal(
  renderWikilinksAsMarkdown("```md\n[[notes/alpha.md|Alpha]]\n```\n[[notes/beta.md|Beta]]"),
  "```md\n[[notes/alpha.md|Alpha]]\n```\n[Beta](<notes/beta.md>)"
);
assert.equal(
  renderWikilinksAsMarkdown("~~~md\n[[notes/alpha.md|Alpha]]\n~~~\n[[notes/beta.md|Beta]]"),
  "~~~md\n[[notes/alpha.md|Alpha]]\n~~~\n[Beta](<notes/beta.md>)"
);
assert.equal(
  renderWikilinksAsMarkdown("```md\n~~~\n[[notes/alpha.md|Alpha]]\n```\n[[notes/beta.md|Beta]]"),
  "```md\n~~~\n[[notes/alpha.md|Alpha]]\n```\n[Beta](<notes/beta.md>)"
);
assert.equal(
  renderWikilinksAsMarkdown("~~~md\n```\n[[notes/alpha.md|Alpha]]\n~~~\n[[notes/beta.md|Beta]]"),
  "~~~md\n```\n[[notes/alpha.md|Alpha]]\n~~~\n[Beta](<notes/beta.md>)"
);
assert.equal(
  renderWikilinksAsMarkdown("```md\n``` not close\n[[notes/alpha.md|Alpha]]\n```\n[[notes/beta.md|Beta]]"),
  "```md\n``` not close\n[[notes/alpha.md|Alpha]]\n```\n[Beta](<notes/beta.md>)"
);
assert.equal(
  renderWikilinksAsMarkdown("```md\r\n[[notes/alpha.md|Alpha]]\r\n```\r\n[[notes/beta.md|Beta]]"),
  "```md\r\n[[notes/alpha.md|Alpha]]\r\n```\r\n[Beta](<notes/beta.md>)"
);
assert.equal(renderWikilinksAsMarkdown("![[notes/alpha.md|Alpha]]"), "![[notes/alpha.md|Alpha]]");
assert.equal(renderWikilinksAsMarkdown("[[notes/alpha.md|Alpha]]"), "[Alpha](<notes/alpha.md>)");
assert.equal(hrefForMarkdownLink("aaaaa-aa", "db-1", "/Wiki/current.md", "/Wiki/foo.md"), "/db/db-1/Wiki/foo.md");
assert.equal(hrefForMarkdownLink("aaaaa-aa", "db-1", "/Wiki/current.md", "/Sources/foo.md#top"), "/db/db-1/Sources/foo.md#top");
assert.equal(hrefForMarkdownLink("aaaaa-aa", "db-1", "/Wiki/current.md", "/Wikipedia/foo.md"), null);
assert.equal(hrefForMarkdownLink("aaaaa-aa", "db-1", "/Wiki/current.md", "/SourcesBackup/foo.md"), null);
assert.equal(inferNoteRole("/Sources/raw/web/abc.md"), "raw_source");
assert.equal(inferNoteRole("/Sources/rawfoo/abc.md"), "markdown_note");

const cachedNodeContext = {
  node: {
    path: "/Wiki/demo.md",
    kind: "file",
    content: "# Demo",
    updatedAt: null,
    etag: "node-etag",
    sizeBytes: 6
  },
  incomingLinks: [],
  outgoingLinks: []
};
const cachedChildren = [child("/Wiki/demo", "demo", "directory")];
const nodeContextCache = new Map([["node-key", cachedNodeContext]]);
const childNodesCache = new Map([["children-key", cachedChildren], ["node-key", cachedChildren]]);
assert.deepEqual(readBrowserNodeCache(nodeContextCache, childNodesCache, "missing-key"), null);
assert.deepEqual(readBrowserNodeCache(nodeContextCache, childNodesCache, "children-key"), {
  kind: "children",
  children: cachedChildren
});
assert.deepEqual(readBrowserNodeCache(nodeContextCache, childNodesCache, "node-key"), {
  kind: "node",
  context: cachedNodeContext
});

assert.equal(formatCycles(12_345_000_000_000n), "12.34T");
assert.equal(formatCycles(850_000_000_000n), "850.00B");
assert.equal(formatCycles(123_450_000n), "123.45M");
assert.equal(formatRawCycles(1234567890123n), "1,234,567,890,123");
assert.equal(cycleTone(5_000_000_000_000n), "blue");
assert.equal(cycleTone(1_000_000_000_000n), "amber");
assert.equal(cycleTone(999_999_999_999n), "red");
assert.equal(cycleTone(null), "gray");
assert.match(searchPanelSource, /searchOptions = DEFAULT_SEARCH_OPTIONS/);
assert.match(searchPanelSource, /searchOptions\.prefix, searchOptions\.preview, readIdentity/);

console.log("UI helper checks OK");

function child(path, name, kind, hasChildren = kind === "directory") {
  return {
    path,
    name,
    kind,
    updatedAt: null,
    etag: null,
    sizeBytes: null,
    isVirtual: false,
    hasChildren
  };
}

async function importTs(relativePath) {
  const sourcePath = new URL(relativePath, import.meta.url);
  const rawSource = readFileSync(sourcePath, "utf8");
  const source = relativePath === "../lib/paths.ts"
    ? `${readFileSync(new URL("../lib/share-links.ts", import.meta.url), "utf8")}\n${rawSource.replace('import { databaseRouteBase } from "./share-links";', "")}`
    : rawSource;
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(moduleUrl);
}
