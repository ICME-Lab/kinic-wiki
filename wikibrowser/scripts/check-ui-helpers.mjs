import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { importStrippedTsForTest } from "../../scripts/strip-ts-for-test.mjs";

const { collectLintHints, provenancePathFor, rawSourceLinksFor } = await importTs("../lib/lint-hints.ts");
const { normalizeSearchHit } = await importTs("../lib/search-normalizer.ts");
const { readBrowserNodeCache } = await importTs("../lib/browser-node-cache.ts");
const { sortChildNodes } = await importTs("../lib/child-sort.ts");
const { folderIndexPath, isFolderIndexNode, isReservedFolderIndexName, visibleChildren } = await importTs("../lib/folder-index.ts");
const { cycleTone, formatCycles, formatRawCycles } = await importTs("../lib/cycles.ts");
const { splitMarkdownPreviewSections } = await importTs("../lib/markdown-sections.ts");
const { safeMarkdownImageSrc } = await importTs("../lib/markdown-images.ts");
const { renderWikilinksAsMarkdown } = await importTs("../lib/markdown-wikilinks.ts");
const { graphRequestKey, nodeRequestKey, searchRequestKey } = await importTs("../lib/request-keys.ts");
const { hrefForMarkdownLink } = await importTs("../lib/paths.ts");
const { parseSearchOptions, prefixForSearchScope } = await importTs("../lib/search-options.ts");
const { isRoutableDatabaseId, publicDatabasePath, publicDatabaseUrl, xShareDatabaseHref } = await importTs("../lib/share-links.ts");
const { canExpandChildNode, inferNoteRole, isDatabaseNotFoundErrorCode, isEmptyStoreRootPath, isStoreRootPath, parseModeTab, readIdentityMode } = await importTs("../lib/wiki-helpers.ts");
const { classifyQueryInput, queryAnswerSearchTerms } = await importTs("../lib/query-actions.ts");
const { databasePreviewDescription, databasePreviewTitle, loadDatabasePreview } = await importTs("../lib/database-preview.ts");
const {
  activePublicDatabases,
  databaseLinkPreviewImageKey: generatedDatabaseLinkPreviewImageKey,
  wranglerObjectPutArgs
} = await import("./generate-link-preview-images.mjs");
const {
  LINK_PREVIEW_IMAGE_CACHE_CONTROL,
  LINK_PREVIEW_IMAGE_CONTENT_TYPE,
  databaseLinkPreviewImageKey,
  pendingDatabaseLinkPreviewImageKey,
  readCachedDatabaseLinkPreviewImage
} = await importTs("../lib/link-preview-images.ts");
const explorerTreeSource = readFileSync(new URL("../components/explorer-tree.tsx", import.meta.url), "utf8");
const documentPaneSource = readFileSync(new URL("../components/document-pane.tsx", import.meta.url), "utf8");
const inspectorSource = readFileSync(new URL("../components/inspector.tsx", import.meta.url), "utf8");
const layoutSource = readFileSync(new URL("../src/routes/__root.tsx", import.meta.url), "utf8");
const homePageSource = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const adminRouteShellSource = readFileSync(new URL("../app/admin-route-shell.tsx", import.meta.url), "utf8");
const marketplaceLayoutSource = readFileSync(new URL("../app/marketplace/layout.tsx", import.meta.url), "utf8");
const marketplaceListingDetailSource = readFileSync(new URL("../app/marketplace/[listingId]/listing-detail-client.tsx", import.meta.url), "utf8");
const dashboardClientSource = readFileSync(new URL("../app/dashboard/dashboard-client.tsx", import.meta.url), "utf8");
const databaseLayoutSource = ["../src/routes/db.$databaseId.tsx", "../app/db/[databaseId]/[[...segments]]/page.tsx"].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
const linkPreviewRegenerateRoutePath = new URL("../app/api/link-preview/regenerate/route.ts", import.meta.url);
const linkPreviewImagePath = new URL("../app/link-preview-image.tsx", import.meta.url);
const openGraphImagePath = new URL("../app/opengraph-image.tsx", import.meta.url);
const twitterImagePath = new URL("../app/twitter-image.tsx", import.meta.url);
const databaseOpenGraphImageSource = readFileSync(new URL("../src/routes/db.$databaseId.opengraph-image.ts", import.meta.url), "utf8");
const databaseTwitterImageSource = readFileSync(new URL("../src/routes/db.$databaseId.twitter-image.ts", import.meta.url), "utf8");
const linkPreviewGeneratorSource = readFileSync(new URL("./generate-link-preview-images.mjs", import.meta.url), "utf8");
const sourceCapturePanelSource = readFileSync(new URL("../components/source-capture-panel.tsx", import.meta.url), "utf8");
const markdownEditDocumentSource = readFileSync(new URL("../components/markdown-edit-document.tsx", import.meta.url), "utf8");
const markdownEditorSource = readFileSync(new URL("../components/markdown-editor.tsx", import.meta.url), "utf8");
const markdownPreviewSource = readFileSync(new URL("../components/markdown-preview.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../components/panel.tsx", import.meta.url), "utf8");
const searchPanelSource = readFileSync(new URL("../components/search-panel.tsx", import.meta.url), "utf8");
const wikiBrowserFiles = [
  "../components/wiki-navigation.tsx",
  "../components/wiki-browser.tsx",
  "../components/wiki-browser/explorer-pane.tsx",
  "../components/wiki-browser/top-bar.tsx"
];
const wikiBrowserSource = wikiBrowserFiles.map((p) => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
const localImportDialogSource = readFileSync(new URL("../components/local-import-dialog.tsx", import.meta.url), "utf8");
const localImportSource = readFileSync(new URL("../lib/local-import.ts", import.meta.url), "utf8");
const queryPanelSource = readFileSync(new URL("../components/query-panel.tsx", import.meta.url), "utf8");
const queryContextSource = readFileSync(new URL("../lib/query-context.ts", import.meta.url), "utf8");
const vfsClientFiles = [
  "../lib/vfs-client.ts",
  "../lib/vfs-client/raw-types.ts",
  "../lib/vfs-client/actor.ts",
  "../lib/vfs-client/cycles.ts",
  "../lib/vfs-client/market.ts"
];
const vfsClientSource = vfsClientFiles.map((p) => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
const databasePreviewSource = readFileSync(new URL("../lib/database-preview.ts", import.meta.url), "utf8");
const wranglerConfigSource = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const assetsIgnoreSource = readFileSync(new URL("../public/.assetsignore", import.meta.url), "utf8");
const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const tailwindConfig = readFileSync(new URL("../tailwind.config.ts", import.meta.url), "utf8");

assert.match(explorerTreeSource, /childNodesCache\.current\.get\(requestKey\)/);
assert.match(explorerTreeSource, /childNodesCache\.current\.set\(requestKey, data\)/);
assert.match(explorerTreeSource, /childNodesCache\.current\.set\(rootRequestKey, data\)/);
assert.match(explorerTreeSource, /if \(emptyStoreRoot\) return null;/);
assert.match(explorerTreeSource, /visibleChildren\(childrenState\.data\)/);
assert.match(explorerTreeSource, /DEFAULT_STORE_ROOT_PATHS\.map/);
assert.match(explorerTreeSource, /listChildren\(canisterId, databaseId, "\/"/);
assert.doesNotMatch(explorerTreeSource, /filterStoreRoots|STORE_ROOT_PATH_SET/);
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
assert.match(wikiBrowserSource, /const graphHref = isGraphPage[\s\S]*hrefForPath\(canisterId, databaseId, graphLinkCenter \?\? "\/Knowledge"/);
assert.match(wikiBrowserSource, /hrefForCanonicalDatabaseRoute\(pathname, searchParams\.toString\(\)\)/);
assert.match(wikiBrowserSource, /navigate\(canonicalRouteHref, \{ guard: false, replace: true \}\)/);
assert.doesNotMatch(wikiBrowserSource, /publicDatabasesLoaded && Boolean\(readIdentity\) && memberDatabasesLoaded/);
assert.doesNotMatch(wikiBrowserSource, /router\.replace\("\/dashboard"\)/);
assert.match(wikiBrowserSource, /<Network size=\{18\} aria-hidden \/>/);
assert.match(wikiBrowserSource, /<Share2 aria-hidden size=\{18\} \/>/);
assert.match(wikiBrowserSource, /Settings/);
assert.match(wikiBrowserSource, /href=\{`\/dashboard\/project\/\$\{encodeURIComponent\(databaseId\)\}`\}/);
assert.match(wikiBrowserSource, /aria-label="Manage database settings"/);
assert.match(wikiBrowserSource, /sr-only sm:not-sr-only/);
assert.match(wikiBrowserSource, /Share2/);
assert.match(wikiBrowserSource, /xShareDatabaseHref/);
assert.match(wikiBrowserSource, /\{publicReadable \? \(\s*<a[\s\S]*xShareDatabaseHref\(\{ databaseId, databaseTitle: currentDatabaseName \}\)[\s\S]*title="Share on X"[\s\S]*<\/a>\s*\) : null\}/);
assert.doesNotMatch(wikiBrowserSource, /hidden items-center gap-1 rounded-lg border border-line[\s\S]*md:flex/);
assert.match(wikiBrowserSource, /value === "edit"/);
assert.match(wikiBrowserSource, /canLeaveDirtyEdit/);
assert.match(wikiBrowserSource, /UNSAVED_MARKDOWN_MESSAGE/);
assert.match(wikiBrowserSource, /deleteNodeAuthenticated/);
assert.match(wikiBrowserSource, /writeNodeAuthenticated/);
assert.match(wikiBrowserSource, /mkdirNodeAuthenticated/);
assert.match(wikiBrowserSource, /moveNodeAuthenticated/);
assert.match(wikiBrowserSource, /Import local files/);
assert.match(wikiBrowserSource, /Import local folder/);
assert.match(wikiBrowserSource, /accept="\.md,\.pdf,text\/markdown,application\/pdf"/);
assert.match(wikiBrowserSource, /webkitdirectory/);
assert.match(wikiBrowserSource, /writeNodesAuthenticated/);
assert.match(localImportDialogSource, /Local \{mode === "folder" \? "folder" : "files"\} → Wiki/);
assert.match(localImportDialogSource, /existing file.*will be kept unless replacement is selected/);
assert.match(localImportDialogSource, /const busy = state\.phase === "writing"/);
assert.match(localImportSource, /LOCAL_IMPORT_NODE_LIMIT = 100/);
assert.match(localImportSource, /LOCAL_IMPORT_BYTE_LIMIT = 1_500_000/);
assert.match(localImportSource, /LOCAL_IMPORT_SOURCE_FILE_BYTE_LIMIT = 20_000_000/);
assert.match(localImportSource, /status === "conflict" && replacements\.has\(entry\.path\)/);
assert.match(wikiBrowserSource, /new AbortController\(\)/);
assert.match(wikiBrowserSource, /localImportAbortController\.current\?\.abort\(\);[\s\S]{0,240}\}, \[canisterId, databaseId\]\);/);
assert.match(wikiBrowserSource, /nodeContextCache\.current\.clear\(\)/);
assert.match(wikiBrowserSource, /childNodesCache\.current\.clear\(\)/);
assert.match(wikiBrowserSource, /expectedEtag: null/);
assert.match(wikiBrowserSource, /folderIndexPath\(selectedPath\)/);
assert.match(wikiBrowserSource, /Use folder Edit to create index\.md\./);
assert.match(wikiBrowserSource, /const \{ deleteNodeAuthenticated, readNode \} = await import\("@\/lib\/vfs-client"\)/);
assert.match(wikiBrowserSource, /readNode\(canisterId, databaseId, folderIndexPath\(target\.path\), readIdentity\)/);
assert.match(wikiBrowserSource, /if \(!isNotFoundError\(cause\)\) throw cause;/);
assert.doesNotMatch(wikiBrowserSource, /path: indexNode\.path/);
assert.match(wikiBrowserSource, /expectedFolderIndexEtag: indexNode\?\.etag \?\? null/);
assert.match(wikiBrowserSource, /\|\| node\.kind === "source"/);
assert.match(wikiBrowserSource, /Only Markdown files, source nodes, and folders without visible children can be deleted\./);
assert.doesNotMatch(wikiBrowserSource, /currentFolderIndexNode\.data\?\.path === folderIndexPath\(target\.path\)/);
assert.match(wikiBrowserSource, /memberDatabases\.find/);
assert.match(wikiBrowserSource, /SIDEBAR_TABS: ModeTab\[\] = \["explorer", "query", "source-capture"\]/);
assert.doesNotMatch(wikiBrowserSource, /ClipperPanel/);
assert.match(wikiBrowserSource, /publicDatabaseIds/);
assert.match(wikiBrowserSource, /databaseTitle=\{currentDatabase\?\.metadata\.name \?\? ""\}/);
assert.match(inspectorSource, /databaseTitle: string/);
assert.match(inspectorSource, /label="database"/);
assert.match(inspectorSource, /label="database_id"/);
assert.match(inspectorSource, /label="created_at"/);
assert.match(inspectorSource, /label="metadata_json"/);
assert.match(layoutSource, /title: "Kinic Wiki AI Memory"/);
assert.match(layoutSource, /content: "Use Kinic Wiki as canister-backed AI memory through kinic-vfs-cli, with browser tools for browsing and management\."/);
assert.match(layoutSource, /property: "og:title"/);
assert.match(layoutSource, /name: "twitter:card", content: "summary_large_image"/);
assert.match(homePageSource, /url: "\/opengraph-image\.png"/);
assert.match(homePageSource, /width: 1200/);
assert.match(homePageSource, /height: 630/);
assert.match(homePageSource, /card: "summary_large_image"/);
assert.match(homePageSource, /url: "\/twitter-image\.png"/);
assert.doesNotMatch(layoutSource, /Read-only browser|Wiki Canister Browser/);
assert.doesNotMatch(layoutSource, /AppSessionProvider|AppHeader|AdminShell/);
assert.match(adminRouteShellSource, /AppSessionProvider/);
assert.match(adminRouteShellSource, /<AppHeader \/>/);
assert.match(adminRouteShellSource, /<AdminShell>\{children\}<\/AdminShell>/);
assert.match(marketplaceLayoutSource, /<AdminRouteShell>/);
assert.match(marketplaceLayoutSource, /<AdminContent>\{children\}<\/AdminContent>/);
assert.match(wranglerConfigSource, /"r2_buckets"/);
assert.match(assetsIgnoreSource, /^\.DS_Store$/m, "static asset uploads must exclude macOS metadata");
assert.match(wranglerConfigSource, /"binding": "LINK_PREVIEW_IMAGES"/);
assert.match(wranglerConfigSource, /"bucket_name": "kinic-wiki-link-preview-images"/);
assert.match(wranglerConfigSource, /"queues"/);
assert.match(wranglerConfigSource, /"binding": "LINK_PREVIEW_QUEUE"/);
assert.match(wranglerConfigSource, /"queue": "kinic-wiki-generation"/);
assert.equal(existsSync(linkPreviewRegenerateRoutePath), false);
assert.equal(existsSync(linkPreviewImagePath), false);
assert.equal(existsSync(openGraphImagePath), false);
assert.equal(existsSync(twitterImagePath), false);
assert.match(linkPreviewGeneratorSource, /@vercel\/og/);
assert.match(linkPreviewGeneratorSource, /ImageResponse/);
assert.match(linkPreviewGeneratorSource, /wranglerObjectPutArgs/);
assert.doesNotMatch(`${homePageSource}\n${databaseOpenGraphImageSource}\n${databaseTwitterImageSource}`, /next\/og|ImageResponse/);
assert.match(databaseLayoutSource, /wikiDatabaseHead/);
assert.match(databaseLayoutSource, /<div className="wiki-seo-region">/);
assert.doesNotMatch(databaseLayoutSource, /aria-hidden="true" className="wiki-seo-region"|inert/);
assert.match(globalsCss, /\.wiki-seo-region\s*\{\s*display: block;/);
assert.match(globalsCss, /@media \(scripting: enabled\)/);
assert.doesNotMatch(globalsCss, /\.wiki-seo-region\s*\{[^}]*left: -10000px|\.wiki-seo-region\s*\{[^}]*width: 1px|\.wiki-seo-region\s*\{[^}]*height: 1px/);
assert.match(databaseLayoutSource, /`\$\{databaseRouteBase\(databaseId\)\}\/opengraph-image`/);
assert.match(databaseLayoutSource, /`\$\{databaseRouteBase\(databaseId\)\}\/twitter-image`/);
assert.match(databaseOpenGraphImageSource, /readCachedDatabaseLinkPreviewImage\(request, canonicalDatabaseId\(params\.databaseId\), "\/opengraph-image\.png"/);
assert.doesNotMatch(databaseOpenGraphImageSource, /isReservedDatabaseRouteSlug|notFound\(\)/);
assert.doesNotMatch(databaseOpenGraphImageSource, /renderLinkPreviewImage|loadDatabasePreview|ImageResponse/);
assert.match(databaseTwitterImageSource, /readCachedDatabaseLinkPreviewImage\(request, canonicalDatabaseId\(params\.databaseId\), "\/twitter-image\.png"/);
assert.doesNotMatch(databaseTwitterImageSource, /isReservedDatabaseRouteSlug|notFound\(\)/);
assert.doesNotMatch(databaseTwitterImageSource, /renderLinkPreviewImage|loadDatabasePreview|ImageResponse/);
assert.deepEqual(
  activePublicDatabases([
    { database_id: "db_active", name: "fallback", metadata: { name: "Active DB", description: "Public database" }, status: "active" },
    { database_id: "db_pending", name: "Pending DB", metadata: { name: "Pending DB", description: "" }, status: "pending" }
  ]),
  [{ databaseId: "db_active", title: "Active DB", description: "Public database" }]
);
assert.equal(generatedDatabaseLinkPreviewImageKey(" db alpha "), "db-link-preview/v1/db%20alpha.png");
assert.deepEqual(wranglerObjectPutArgs("bucket", "db-link-preview/v1/db_alpha.png", "/tmp/db_alpha.png"), [
  "exec",
  "wrangler",
  "r2",
  "object",
  "put",
  "bucket/db-link-preview/v1/db_alpha.png",
  "--remote",
  "--file",
  "/tmp/db_alpha.png",
  "--content-type",
  "image/png",
  "--cache-control",
  "public, max-age=300, s-maxage=86400"
]);
assert.match(databasePreviewSource, /databasePreviewTitle/);
assert.match(databasePreviewSource, /databasePreviewDescription/);
assert.match(databasePreviewSource, /listDatabasesPublic/);
assert.doesNotMatch(databasePreviewSource, /withTimeout/);
const databasePreview = await loadDatabasePreview("canister-id", " db_alpha ");
assert.deepEqual(databasePreview, {
  databaseId: "db_alpha",
  databaseTitle: "db_alpha",
  description: "",
  publicReadable: false
});
const aliasDatabasePreview = await loadDatabasePreview("canister-id", " db_bfzk4yokfnin ");
assert.equal(aliasDatabasePreview.databaseId, "db_nnoe2kborlsq");
assert.equal(databasePreviewTitle(databasePreview.databaseTitle), "Kinic Wiki: db_alpha");
assert.equal(databasePreviewDescription(databasePreview), "Browse, search, and query the db_alpha wiki database.");
assert.equal(databaseLinkPreviewImageKey(" db alpha "), "db-link-preview/v1/db%20alpha.png");
class LinkPreviewTestBucket {
  constructor(objects = {}) {
    this.objects = objects;
    this.puts = [];
    this.deletes = [];
  }

  async get(key) {
    return this.objects[key] ?? null;
  }

  async put(key, value, options) {
    this.puts.push({ key, value, options });
  }

  async delete(key) {
    this.deletes.push(key);
  }
}
const queuedMessages = [];
const imageMissBucket = new LinkPreviewTestBucket();
const imageMiss = await readCachedDatabaseLinkPreviewImage(
  new Request("https://local.test/db/db_alpha/opengraph-image"),
  "db_alpha",
  "/opengraph-image.png",
  imageMissBucket,
  {
    queue: { send: async (message) => queuedMessages.push(message) },
    canisterId: "canister-1",
    nowMs: Date.parse("2026-05-12T00:00:00.000Z")
  }
);
assert.equal(imageMiss.status, 307);
assert.equal(imageMiss.headers.get("location"), "https://local.test/opengraph-image.png");
assert.equal(imageMiss.headers.get("cache-control"), "no-store");
assert.deepEqual(queuedMessages, [
  {
    kind: "link_preview",
    canisterId: "canister-1",
    databaseId: "db_alpha",
    requestedAt: "2026-05-12T00:00:00.000Z"
  }
]);
assert.equal(imageMissBucket.puts[0]?.key, "db-link-preview/pending/v1/db_alpha.json");
assert.equal(pendingDatabaseLinkPreviewImageKey(" db alpha "), "db-link-preview/pending/v1/db%20alpha.json");
const imageHit = await readCachedDatabaseLinkPreviewImage(
  new Request("https://local.test/db/db_alpha/twitter-image"),
  "db_alpha",
  "/twitter-image.png",
  new LinkPreviewTestBucket({
    "db-link-preview/v1/db_alpha.png": {
        body: new Response(new Uint8Array([1, 2, 3])).body,
        httpEtag: '"etag-db-alpha"'
    }
  }),
  {
    queue: { send: async () => queuedMessages.push({ unexpected: true }) },
    canisterId: "canister-1"
  }
);
assert.equal(imageHit.status, 200);
assert.equal(imageHit.headers.get("content-type"), LINK_PREVIEW_IMAGE_CONTENT_TYPE);
assert.equal(imageHit.headers.get("cache-control"), LINK_PREVIEW_IMAGE_CACHE_CONTROL);
assert.equal(imageHit.headers.get("etag"), '"etag-db-alpha"');
assert.equal((await imageHit.arrayBuffer()).byteLength, 3);
const pendingBucket = new LinkPreviewTestBucket({
  "db-link-preview/pending/v1/db_alpha.json": {
    body: new Response("{}").body,
    customMetadata: { requestedAtMs: String(Date.parse("2026-05-12T00:00:00.000Z")) }
  }
});
const pendingMessages = [];
const pendingResponse = await readCachedDatabaseLinkPreviewImage(
  new Request("https://local.test/db/db_alpha/twitter-image"),
  "db_alpha",
  "/twitter-image.png",
  pendingBucket,
  {
    queue: { send: async (message) => pendingMessages.push(message) },
    canisterId: "canister-1",
    nowMs: Date.parse("2026-05-12T00:05:00.000Z")
  }
);
assert.equal(pendingResponse.status, 307);
assert.equal(pendingResponse.headers.get("cache-control"), "no-store");
assert.equal(pendingMessages.length, 0);
assert.equal(pendingBucket.puts.length, 0);
const failingBucket = new LinkPreviewTestBucket();
const failingResponse = await readCachedDatabaseLinkPreviewImage(
  new Request("https://local.test/db/db_alpha/twitter-image"),
  "db_alpha",
  "/twitter-image.png",
  failingBucket,
  {
    queue: {
      send: async () => {
        throw new Error("queue down");
      }
    },
    canisterId: "canister-1",
    nowMs: Date.parse("2026-05-12T00:00:00.000Z")
  }
);
assert.equal(failingResponse.status, 307);
assert.equal(failingResponse.headers.get("cache-control"), "no-store");
assert.deepEqual(failingBucket.deletes, ["db-link-preview/pending/v1/db_alpha.json"]);
const missingBucketResponse = await readCachedDatabaseLinkPreviewImage(
  new Request("https://local.test/db/db_alpha/opengraph-image"),
  "db_alpha",
  "/opengraph-image.png",
  null
);
assert.equal(missingBucketResponse.status, 307);
assert.equal(missingBucketResponse.headers.get("location"), "https://local.test/opengraph-image.png");
assert.equal(missingBucketResponse.headers.get("cache-control"), "no-store");
assert.match(queryPanelSource, /authorizeQueryAnswerSession/);
assert.match(queryPanelSource, /Login with Internet Identity to ask wiki questions/);
assert.match(queryPanelSource, /sessionNonce/);
assert.match(queryPanelSource, /2_000/);
assert.match(queryPanelSource, /searchNodes\(canisterId, databaseId, action\.query, 10, null, "light", readIdentity \?\? undefined\)/);
assert.match(queryPanelSource, /readAnswerResponseBody/);
assert.match(queryPanelSource, /returned invalid JSON/);
assert.match(queryPanelSource, /non-JSON response/);
assert.match(queryPanelSource, /htmlFor="query-command">Query/);
assert.match(queryPanelSource, /LLM answer/);
assert.doesNotMatch(queryPanelSource, /Search by default/);
assert.match(queryPanelSource, /non-LLM/);
assert.match(queryPanelSource, /read-only/);
assert.match(searchPanelSource, /Custom prefix/);
assert.match(searchPanelSource, /Database search/);
assert.match(searchPanelSource, /Searching database\.\.\./);
assert.match(searchPanelSource, /onCustomPrefixCommit/);
assert.match(searchPanelSource, /searchOptions\.limit/);
assert.match(searchPanelSource, /searchOptions\.preview/);
assert.match(vfsClientSource, /preview_mode: searchPreviewModeArg\(previewMode\)/);
assert.match(queryContextSource, /isAnswerContextNode\(input\.currentNode\)/);
assert.match(queryContextSource, /queryAnswerSearchTerms\(input\.question\)/);
assert.match(
  queryContextSource,
  /queryContext\(\s*input\.canisterId,\s*input\.databaseId,\s*input\.question,\s*CONTEXT_BUDGET_TOKENS,\s*input\.readIdentity \?\? undefined\s*\)/
);
assert.match(queryContextSource, /searchNodes\(input\.canisterId, input\.databaseId, term, MAX_CONTEXT_ITEMS \* 2, null, "light", input\.readIdentity \?\? undefined\)/);
assert.match(queryContextSource, /rankAnswerPaths/);
assert.match(queryContextSource, /isRawSourcePath/);
assert.match(queryContextSource, /const primary = paths\.filter\(\(path\) => !isRawSourcePath\(path\)\)/);
assert.match(queryContextSource, /return \[\.\.\.primary, \.\.\.sources\]/);
assert.match(queryContextSource, /readNodeContext\(input\.canisterId, input\.databaseId, hit, 5/);
assert.match(queryContextSource, /node\.kind === "file" \|\| node\.kind === "source"/);
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
assert.match(wikiBrowserSource, /isMutableExplorerNode/);
assert.doesNotMatch(wikiBrowserSource, /Only \/Knowledge/);
assert.doesNotMatch(wikiBrowserSource, /under \/Knowledge/);
assert.match(wikiBrowserSource, /isProtectedRootFolder\(node\.path\)/);
assert.match(wikiBrowserSource, /new Set<string>\(STORE_ROOT_PATHS\)/);
assert.match(wikiBrowserSource, /STORE_ROOT_PATHS\.some\(\(root\) => path === root/);
assert.match(wikiBrowserSource, /node\.kind === "folder"/);
assert.match(wikiBrowserSource, /visibleChildren\(loadedChildren, node\.path\)\.length === 0/);
assert.match(wikiBrowserSource, /: !node\.hasChildren/);
assert.doesNotMatch(wikiBrowserSource, /DocumentBreadcrumbs/);
assert.doesNotMatch(wikiBrowserSource, /readMode/);
assert.match(documentPaneSource, /DocumentHeaderPath/);
assert.match(documentPaneSource, /DatabaseNotFoundState/);
assert.match(documentPaneSource, /Database not found/);
assert.match(documentPaneSource, /Open dashboard/);
assert.match(documentPaneSource, /href="\/dashboard"/);
assert.match(documentPaneSource, /isDatabaseNotFoundErrorCode\(node\.code\) \|\| isDatabaseNotFoundErrorCode\(childrenState\.code\)/);
assert.doesNotMatch(documentPaneSource, /sqlite error/);
assert.match(explorerTreeSource, /isDatabaseNotFoundErrorCode\(code\) \? null : message/);
assert.match(explorerTreeSource, /rootDatabaseNotFound \? \[\] : rootNodeData/);
assert.match(vfsClientSource, /classifyCanisterError\(message\)/);
assert.match(documentPaneSource, /Current knowledge path/);
assert.match(documentPaneSource, /h-9 w-fit min-w-0 max-w-full/);
assert.match(documentPaneSource, /sm:h-10/);
assert.match(documentPaneSource, /hrefForPath\(canisterId, databaseId, crumbPath/);
assert.match(documentPaneSource, /label="Edit"/);
assert.match(documentPaneSource, /MobileCopyPathButton/);
assert.match(documentPaneSource, /sm:hidden/);
assert.match(documentPaneSource, /Copy path/);
assert.match(documentPaneSource, /Copy raw/);
assert.doesNotMatch(documentPaneSource, /isDirectory \? "directory" : "node"/);
assert.doesNotMatch(documentPaneSource, /displayPath/);
assert.match(documentPaneSource, /navigator\.clipboard\.writeText/);
assert.match(documentPaneSource, /toast\.success\(`\$\{label\} copied`\)/);
assert.match(documentPaneSource, /toast\.error\(`\$\{label\} copy failed`\)/);
assert.doesNotMatch(documentPaneSource, /copyStatus/);
assert.doesNotMatch(documentPaneSource, /setCopyStatus/);
assert.doesNotMatch(documentPaneSource, /label="Saved"/);
assert.match(layoutSource, /import \{ Toaster \} from "sonner"/);
assert.match(layoutSource, /<Toaster richColors position="bottom-right" \/>/);
assert.match(sourceCapturePanelSource, /toast\.success\(`Queued and accepted \$\{created\.requestPath\}`\)/);
assert.match(sourceCapturePanelSource, /toast\.error\(`Queued \$\{created\.requestPath\}\. \$\{created\.triggerError\}`\)/);
assert.match(markdownEditDocumentSource, /toast\.success\("Saved"\)/);
assert.match(markdownEditDocumentSource, /toast\.error\(message\)/);
assert.match(dashboardClientSource, /toast\.success\("Access updated\."\)/);
assert.match(dashboardClientSource, /toast\.success\("Listing published\."\)/);
assert.match(dashboardClientSource, /toast\.error\(errorMessage\(cause\)\)/);
assert.doesNotMatch(dashboardClientSource, /actionMessage/);
assert.doesNotMatch(dashboardClientSource, /actionTone/);
assert.match(marketplaceListingDetailSource, /toast\.success\(`Purchase complete\. Ledger block \$\{order\.ledgerBlockIndex\}\.`\)/);
assert.match(marketplaceListingDetailSource, /toast\.info\("Access is already active\."\)/);
assert.match(marketplaceListingDetailSource, /toast\.error\(message\)/);
assert.match(documentPaneSource, /node\.data\?\.kind === "folder"/);
assert.match(documentPaneSource, /FolderIndexSection/);
assert.match(documentPaneSource, /emptyFolderIndexNode/);
assert.match(documentPaneSource, /isKnowledgeSourcePath\(node\.path\)/);
assert.match(markdownPreviewSource, /valueFor\(fields, "source_path"\) \?\? valueFor\(fields, "kinic\.source_path"\) \?\? valueFor\(fields, "kinic\.store_path"\)/);
assert.match(markdownPreviewSource, />\s*store\{" "\}/);
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
assert.match(markdownPreviewSource, /img\(\{ src, alt,/);
assert.match(markdownPreviewSource, /safeMarkdownImageSrc\(src\)/);
assert.match(markdownPreviewSource, /return alt \? <span className="text-xs text-muted">\{alt\}<\/span> : null/);
assert.match(globalsCss, /button:not\(:disabled\):active/);
assert.match(globalsCss, /transform: translateY\(-1px\)/);
assert.match(globalsCss, /button\[aria-busy="true"\]/);
assert.match(globalsCss, /prefers-reduced-motion/);
assert.match(globalsCss, /\.markdown-body img \{/);
assert.match(globalsCss, /max-width: 100%;/);
assert.match(globalsCss, /height: auto;/);
assert.match(tailwindConfig, /accent: "#ff2686"/);
assert.match(tailwindConfig, /action: "#000000"/);
assert.match(tailwindConfig, /paper: "#f8f8f8"/);
assert.doesNotMatch(tailwindConfig, /#1f6feb|#7c3aed|#6d28d9|#f6f1e8|#fffdf8|#ded7cb/);
assert.doesNotMatch(globalsCss, /#1f6feb|#7c3aed|#6d28d9|#f6f1e8|#efe7d8|#ded7cb/);

const factsHints = collectLintHints("/Knowledge/demo/facts.md", "Deadline is May 10.\nStable value is blue.");
assert.equal(factsHints.length, 1);
assert.equal(factsHints[0].title, "Possible future or pending item");
assert.equal(factsHints[0].preview, "Deadline is May 10.");

const summaryHints = collectLintHints("/Knowledge/demo/summary.md", "Receipt AB-123456 was filed.");
assert.equal(summaryHints.length, 1);
assert.equal(summaryHints[0].title, "Possible exact evidence leak");

const codeHints = collectLintHints("/Knowledge/demo/code-note.md", "- Implementation: `crates/vfs_store/src/fs_store.rs`");
assert.equal(codeHints.length, 1);
assert.equal(codeHints[0].title, "Code note lacks decision context");
assert.equal(codeHints[0].preview, "- Implementation: `crates/vfs_store/src/fs_store.rs`");

assert.deepEqual(
  rawSourceLinksFor("/Knowledge/demo/provenance.md", "- Raw: /Sources/demo/source.md\n- Raw: /Sources/demo/source.md"),
  ["/Sources/demo/source.md"]
);
assert.deepEqual(
  rawSourceLinksFor("/Sources/demo/source.md", "# Raw"),
  ["/Sources/demo/source.md"]
);
assert.deepEqual(
  rawSourceLinksFor("/Knowledge/demo/provenance.md", "- Raw: /Sources/123/source.md\n- Bad: /Sources/web/a..b.md"),
  ["/Sources/123/source.md", "/Sources/web/a..b.md"]
);
assert.deepEqual(
  rawSourceLinksFor("/Knowledge/demo/provenance.md", "- Raw: /Sources/sessions/codex/run_123.md\n- Raw: /Sources/skill-runs/legal-review/1700000000000.md"),
  ["/Sources/sessions/codex/run_123.md", "/Sources/skill-runs/legal-review/1700000000000.md"]
);

assert.deepEqual(parseSearchOptions(new URLSearchParams("")), {
  scope: "root",
  prefix: "/",
  limit: 20,
  preview: "default"
});
assert.deepEqual(parseSearchOptions(new URLSearchParams("scope=sources&limit=50&preview=content-start")), {
  scope: "sources",
  prefix: "/Sources",
  limit: 50,
  preview: "content-start"
});
assert.deepEqual(parseSearchOptions(new URLSearchParams("scope=wiki&limit=50")), {
  scope: "root",
  prefix: "/",
  limit: 50,
  preview: "default"
});
assert.deepEqual(parseSearchOptions(new URLSearchParams("scope=custom&prefix=Knowledge/project&limit=100&preview=none")), {
  scope: "custom",
  prefix: "/Knowledge/project",
  limit: 100,
  preview: "none"
});
assert.deepEqual(parseSearchOptions(new URLSearchParams("scope=custom&prefix=&limit=999&preview=semantic")), {
  scope: "custom",
  prefix: "/",
  limit: 20,
  preview: "default"
});
assert.equal(prefixForSearchScope("root", "/ignored"), "/");
assert.equal(provenancePathFor("/Knowledge/demo/facts.md"), "/Knowledge/demo/provenance.md");
assert.equal(provenancePathFor("/Knowledge/demo/provenance.md"), null);

const sortedChildren = sortChildNodes([
  child("/Knowledge/10.md", "10.md", "file"),
  child("/Knowledge/2.md", "2.md", "file"),
  child("/Knowledge/beta", "beta", "folder"),
  child("/Knowledge/1.md", "1.md", "file"),
  child("/Knowledge/alpha", "alpha", "folder")
]);
assert.deepEqual(
  sortedChildren.map((node) => node.path),
  ["/Knowledge/alpha", "/Knowledge/beta", "/Knowledge/1.md", "/Knowledge/2.md", "/Knowledge/10.md"]
);
assert.equal(folderIndexPath("/Knowledge/project"), "/Knowledge/project/index.md");
assert.equal(folderIndexPath("/Knowledge/project/"), "/Knowledge/project/index.md");
assert.equal(isFolderIndexNode(child("/Knowledge/project/index.md", "index.md", "file"), "/Knowledge/project"), true);
assert.equal(isFolderIndexNode(child("/Knowledge/project/note.md", "note.md", "file"), "/Knowledge/project"), false);
assert.equal(isReservedFolderIndexName("INDEX.md"), true);
assert.deepEqual(
  visibleChildren([
    child("/Knowledge/project/index.md", "index.md", "file"),
    child("/Knowledge/project/note.md", "note.md", "file")
  ], "/Knowledge/project").map((node) => node.path),
  ["/Knowledge/project/note.md"]
);
assert.deepEqual(
  visibleChildren([
    child("/Knowledge/project/index.md", "index.md", "file")
  ], "/Knowledge/project").map((node) => node.path),
  []
);
assert.equal(canExpandChildNode(child("/Knowledge/file-parent", "file-parent", "file", true)), true);
assert.equal(canExpandChildNode(child("/Knowledge/file-leaf.md", "file-leaf.md", "file", false)), false);
assert.equal(canExpandChildNode(child("/Knowledge/folder", "folder", "folder", false)), true);
assert.equal(isStoreRootPath("/Knowledge"), true);
assert.equal(isStoreRootPath("/Knowledge/demo"), false);
assert.equal(isDatabaseNotFoundErrorCode("database_not_found"), true);
assert.equal(isDatabaseNotFoundErrorCode("node_not_found"), false);
assert.equal(isDatabaseNotFoundErrorCode(null), false);
assert.equal(isEmptyStoreRootPath("/Knowledge", []), true);
assert.equal(isEmptyStoreRootPath("/Knowledge", [child("/Knowledge/index.md", "index.md", "file")]), true);
assert.equal(isEmptyStoreRootPath("/Knowledge", [child("/Knowledge/demo.md", "demo.md", "file")]), false);
assert.equal(isEmptyStoreRootPath("/Knowledge/demo", []), false);
assert.equal(isEmptyStoreRootPath("/Project", []), false);
assert.equal(parseModeTab("query"), "query");
assert.equal(parseModeTab("clipper"), "explorer");
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
assert.equal(classifyQueryInput("https://example.com/a", "/Knowledge", "user").kind, "queue_url");
assert.deepEqual(classifyQueryInput("sql: SELECT json_object('url', 'https://example.com/a')", "/Knowledge", "anonymous"), {
  kind: "sql",
  targetPath: "current database",
  sideEffect: "none",
  identityMode: "anonymous",
  sql: "SELECT json_object('url', 'https://example.com/a')"
});
assert.deepEqual(classifyQueryInput("topic", "/Knowledge", "user"), {
  kind: "search",
  targetPath: "current database",
  sideEffect: "none",
  identityMode: "user",
  query: "topic"
});
assert.equal(classifyQueryInput("recent", "/Knowledge", "user").kind, "search");
assert.equal(classifyQueryInput("lint facts", "/Knowledge/current.md", "user").targetPath, "/Knowledge/facts.md");
assert.deepEqual(classifyQueryInput("budget", "/Knowledge", "anonymous"), {
  kind: "search",
  targetPath: "current database",
  sideEffect: "none",
  identityMode: "anonymous",
  query: "budget"
});
assert.deepEqual(classifyQueryInput("search: budget", "/Knowledge", "user"), {
  kind: "search",
  targetPath: "current database",
  sideEffect: "none",
  identityMode: "user",
  query: "budget"
});
assert.deepEqual(classifyQueryInput("ask: budget status", "/Knowledge", "user"), {
  kind: "ask",
  targetPath: "/Knowledge",
  sideEffect: "none",
  identityMode: "user",
  question: "budget status"
});
assert.equal(classifyQueryInput("前の方針は？", "/Knowledge", "user").kind, "ask");

const hit = normalizeSearchHit({
  path: "/Knowledge/demo.md",
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
  path: "/Knowledge/demo.md",
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
  path: "/Knowledge/demo",
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
assert.equal(safeMarkdownImageSrc("https://example.com/a.png"), "https://example.com/a.png");
assert.equal(safeMarkdownImageSrc(" HTTPS://example.com/a.png "), "https://example.com/a.png");
assert.equal(safeMarkdownImageSrc("http://example.com/a.png"), null);
assert.equal(safeMarkdownImageSrc("//example.com/a.png"), null);
assert.equal(safeMarkdownImageSrc("javascript:alert(1)"), null);
assert.equal(safeMarkdownImageSrc("/Knowledge/a.png"), null);
assert.equal(safeMarkdownImageSrc("./a.png"), null);
assert.equal(safeMarkdownImageSrc("data:image/png;base64,aaaa"), null);
assert.notEqual(nodeRequestKey("aaaaa-aa", "alpha", "/Knowledge/index.md"), nodeRequestKey("bbbbb-bb", "alpha", "/Knowledge/index.md"));
assert.notEqual(
  graphRequestKey("aaaaa-aa", "alpha", "/Knowledge/index.md", 1),
  graphRequestKey("aaaaa-aa", "alpha", "/Knowledge/index.md", 2)
);
assert.equal(graphRequestKey("aaaaa-aa", "alpha", null, 1), null);
assert.equal(searchRequestKey("aaaaa-aa", "alpha", "path", "budget"), searchRequestKey("aaaaa-aa", "alpha", "path", "budget"));
assert.notEqual(searchRequestKey("aaaaa-aa", "alpha", "path", "budget"), searchRequestKey("aaaaa-aa", "alpha", "full", "budget"));
assert.notEqual(searchRequestKey("aaaaa-aa", "alpha", "path", "budget"), searchRequestKey("aaaaa-aa", "beta", "path", "budget"));
assert.notEqual(searchRequestKey("aaaaa-aa", "alpha", "path", "budget"), searchRequestKey("bbbbb-bb", "alpha", "path", "budget"));
assert.notEqual(nodeRequestKey("aaaaa-aa", "alpha", "/Knowledge/index.md"), nodeRequestKey("aaaaa-aa", "alpha", "/Knowledge/index.md", "aaaaa-aa"));
assert.notEqual(
  graphRequestKey("aaaaa-aa", "alpha", "/Knowledge/index.md", 1),
  graphRequestKey("aaaaa-aa", "alpha", "/Knowledge/index.md", 1, "aaaaa-aa")
);
assert.notEqual(searchRequestKey("aaaaa-aa", "alpha", "path", "budget"), searchRequestKey("aaaaa-aa", "alpha", "path", "budget", "aaaaa-aa"));
assert.equal(publicDatabasePath("alpha/db"), "/db/alpha%2Fdb/Knowledge");
assert.equal(publicDatabasePath("db_example"), "/db/db_example/Knowledge");
assert.equal(publicDatabaseUrl("alpha db"), "https://wiki.kinic.xyz/db/alpha%20db/Knowledge");
assert.equal(publicDatabaseUrl("alpha db", "http://127.0.0.1:3000"), "http://127.0.0.1:3000/db/alpha%20db/Knowledge");
assert.equal(isRoutableDatabaseId("db_xuwmtks27uik"), true);
assert.equal(isRoutableDatabaseId("dashboard"), true);
assert.equal(isRoutableDatabaseId(""), false);
assert.throws(() => publicDatabasePath(""), /invalid database id/);
assert.equal(
  xShareDatabaseHref({ databaseId: "alpha db", databaseTitle: "Research DB", origin: "https://wiki.kinic.xyz" }),
  "https://twitter.com/intent/tweet?text=Kinic+Wiki%3A+Research+DB&url=https%3A%2F%2Fwiki.kinic.xyz%2Fdb%2Falpha%2520db%2FKnowledge"
);
assert.equal(
  renderWikilinksAsMarkdown("[[/Sources/a/a.md|opencode.ai/DESIGN.md]]"),
  "[opencode.ai/DESIGN.md](</Sources/a/a.md>)"
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
assert.equal(hrefForMarkdownLink("aaaaa-aa", "db-1", "/Knowledge/current.md", "/Knowledge/foo.md"), "/db/db-1/Knowledge/foo.md");
assert.equal(hrefForMarkdownLink("aaaaa-aa", "db-1", "/Knowledge/current.md", "/Memory/foo.md"), "/db/db-1/Memory/foo.md");
assert.equal(hrefForMarkdownLink("aaaaa-aa", "db-1", "/Knowledge/current.md", "/Sources/foo.md#top"), "/db/db-1/Sources/foo.md#top");
assert.equal(hrefForMarkdownLink("aaaaa-aa", "db-1", "/Knowledge/current.md", "/Wikipedia/foo.md"), null);
assert.equal(hrefForMarkdownLink("aaaaa-aa", "db-1", "/Knowledge/current.md", "/SourcesBackup/foo.md"), null);
assert.equal(inferNoteRole("/Sources/web/abc.md"), "evidence_source");
assert.equal(inferNoteRole("/Sources/123/abc.md"), "evidence_source");
assert.equal(inferNoteRole("/Sources/sessions/abc/abc.md"), "evidence_source");
assert.equal(inferNoteRole("/Sources/skill-runs/name/run.md"), "evidence_source");
assert.equal(inferNoteRole("/Sources/raw/abc.md"), "evidence_source");
assert.equal(inferNoteRole("/Sourcesfoo/abc.md"), "markdown_note");

const cachedNodeContext = {
  node: {
    path: "/Knowledge/demo.md",
    kind: "file",
    content: "# Demo",
    updatedAt: null,
    etag: "node-etag",
    sizeBytes: 6
  },
  incomingLinks: [],
  outgoingLinks: []
};
const cachedChildren = [child("/Knowledge/demo", "demo", "directory")];
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
  const shareLinksSource = readFileSync(new URL("../lib/share-links.ts", import.meta.url), "utf8");
  const folderIndexSource = readFileSync(new URL("../lib/folder-index.ts", import.meta.url), "utf8");
  const pathsSource = readFileSync(new URL("../lib/paths.ts", import.meta.url), "utf8").replace('import { databaseRouteBase } from "./share-links";', "");
  const source = relativePath === "../lib/paths.ts"
    ? `${shareLinksSource}\n${pathsSource}`
    : relativePath === "../lib/wiki-helpers.ts"
      ? `${folderIndexSource}\n${rawSource.replace('import { visibleChildren } from "@/lib/folder-index";', "")}`
    : relativePath === "../lib/database-preview.ts"
      ? `${shareLinksSource}\n${pathsSource}\n${rawSource.replace('import { canonicalDatabaseId } from "@/lib/paths";', "")}`
      : rawSource;
  return importStrippedTsForTest(source);
}
