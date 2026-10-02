import { Miniflare } from "miniflare";
import { readBuildOutput } from "@cloudflare/build-output-utils";
import { convertToWranglerConfig } from "@cloudflare/config";
// Local workerd verification. This does not measure the hosted Workers CPU quota.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(realpathSync(resolve(root, "node_modules/wrangler/package.json")));

const { build } = require("esbuild");
const output = resolve(root, "../outputs/wiki-cpu/miniflare");
await mkdir(output, { recursive: true });

const fixtures = `
let revoked = false;
export function revoke() { revoked = true; }
const content = {
  db_normal: '# Normal title\\nA **public** note with [link](https://example.com).',
  db_long: '# Long title\\n' + 'long body '.repeat(100000) + 'TAILSENTINEL',
  db_table: '# Table title\\n' + '| [label](https://example.com) | **value** |\\n'.repeat(10000),
  db_unsafe: '# Safe title\\n<script>alert(1)</script> & \\"quoted\\"',
  db_revoked: '# Revoked title\\nREVOCATIONSENTINEL'
};
function accessible(id) { return (id in content || id === 'db_folder') && !(id === 'db_revoked' && revoked); }
export async function listDatabasesPublic() {
  return [...Object.keys(content), 'db_folder'].filter(accessible).map(databaseId => ({
    databaseId, name: 'Fixture database', metadata: {name:'Fixture database',description:'Fixture description'}
  }));
}
export async function readNode(_canister, id, path) {
  if (!accessible(id)) throw new Error('Forbidden or missing');
  if (id === 'db_folder') return {path, kind:path.endsWith('index.md')?'file':'folder', content:path.endsWith('index.md')?'# Folder title\\nFolder body':'',metadataJson:'{}'};
  return {path,kind:'file',content:content[id] ?? '',metadataJson:'{}'};
}
export async function listChildren(_canister, id) {
  if (!accessible(id)) throw new Error('Forbidden or missing');
  return id === 'db_folder' ? Array.from({length:103}, (_,i) => ({path:'/Knowledge/'+(i===0?'index':i-1)+'.md',name:(i===0?'index':i-1)+'.md',kind:'file'})) : [];
}
`;
const fixtureHttp = fixtures + `
export async function fetchPublicSeoPayload(canister,id,path) {
  try {
    const database = (await listDatabasesPublic()).find(item => item.databaseId===id);
    const raw = await readNode(canister,id,path);
    const folder = raw.kind === "folder";
    const node = folder ? await readNode(canister,id,path+"/index.md") : raw;
    const children = folder ? (await listChildren(canister,id)).filter(child => child.name!=="index.md") : [];
    return {database: database ? {metadata:database.metadata} : null,node:node ? {content:node.content.slice(0,16000),metadataJson:node.metadataJson.slice(0,16000)} : null,children:children.slice(0,100),childrenTruncated:children.length>100,hasContent:Boolean(database||node||children.length)};
  } catch { return null; }
}
`;
const entry = `
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadWikiDatabasePageData, WikiDatabaseDocument, wikiDatabaseHead} from './app/db/[databaseId]/[[...segments]]/page';
import {revoke} from '@/lib/public-seo-http';
export default { async fetch(request) {
  const url = new URL(request.url);
  if(url.pathname === '/revoke') { revoke(); return new Response('revoked'); }
  const [id,...segments] = url.pathname.slice(1).split('/');
  const data = await loadWikiDatabasePageData(id,segments);
  return Response.json({data,head:wikiDatabaseHead(data),html:renderToStaticMarkup(React.createElement(WikiDatabaseDocument,{data}))});
}};
`;
const compiled = await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: "miniflare-fixture.tsx", loader: "tsx" },
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  define: { "import.meta.env.VITE_KINIC_WIKI_CANISTER_ID": JSON.stringify("t63gs-up777-77776-aaaba-cai"), "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "fixture-vfs-only", setup(builder) {
    builder.onResolve({filter: /^@\/lib\/public-seo-http$/}, () => ({path: "vfs", namespace: "fixture"}));
    builder.onLoad({filter: /.*/, namespace: "fixture"}, () => ({contents: fixtureHttp, loader: "js"}));
    builder.onResolve({filter: /^@\//}, args => ({path: resolve(root, `${args.path.slice(2)}.ts`)}));
  }}]
});
const base = { compatibilityDate: "2026-07-15", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"], cf: false };
const results = { note: "Local Miniflare/workerd functional verification. Wall time and sampled profiles are not hosted Workers CPU milliseconds.", fixtures: [], live: [] };
const fixtureWorker = new Miniflare({ ...base, modules: true, script: compiled.outputFiles[0].text });
try {
  for (const id of ["db_normal", "db_long", "db_table", "db_unsafe", "db_folder", "db_private", "db_missing"]) {
    for (const concurrency of [1, 5]) {
      const durations = [];
      for (let batch = 0; batch < 20 / concurrency; batch++) {
        await Promise.all(Array.from({length: concurrency}, async () => {
          const start = performance.now();
          const response = await fixtureWorker.dispatchFetch(`https://fixture.local/${id}/Knowledge`);
          assert.equal(response.status, 200);
          const {data, head, html} = await response.json();
          durations.push(performance.now() - start);
          assert.equal(html.includes("wiki-seo-document"), !["db_private", "db_missing"].includes(id));
          assert.ok(data.summary.textExcerpt.length <= 8000);
          assert.ok(!JSON.stringify(data).includes("TAILSENTINEL"));
          assert.ok(!html.includes("<script>"));
          assert.deepEqual(head.meta[0], {title: data.summary.title});
          if (id === "db_folder") {
            assert.equal(data.children.length, 100);
            assert.equal(data.childrenTruncated, true);
            assert.ok(html.includes('/Knowledge/99.md'));
            assert.ok(!html.includes('/Knowledge/100.md'));
            assert.ok(!html.includes('/Knowledge/index.md'));
          }
          if (id === "db_unsafe") assert.ok(html.includes("&amp;"));
        }));
      }
      durations.sort((a,b) => a-b);
      results.fixtures.push({id, concurrency, count: durations.length, wallP95Ms: durations[18]});
    }
  }
  const first = await (await fixtureWorker.dispatchFetch("https://fixture.local/db_revoked/Knowledge")).json();
  assert.ok(first.html.includes("REVOCATIONSENTINEL"));
  await fixtureWorker.dispatchFetch("https://fixture.local/revoke");
  const second = await (await fixtureWorker.dispatchFetch("https://fixture.local/db_revoked/Knowledge")).json();
  assert.equal(second.html, "");
  assert.ok(!JSON.stringify(second).includes("REVOCATIONSENTINEL"));
  results.revocation = "passed: a subsequent request does not reuse public content";
  const tools = await (await fixtureWorker.dispatchFetch("https://fixture.local/db_normal/search")).json();
  assert.equal(tools.html, "");
  assert.ok(tools.head.meta.some(meta => meta.name === "robots" && meta.content === "noindex,follow"));
  results.browserOnly = "passed: no article and noindex metadata";
} finally { await fixtureWorker.dispose(); }

// --live runs the actual production bundle, including router, SSR, ICP transport
// and signature verification. It only reads public canister data.
if (process.argv.includes("--live") || process.argv.includes("--gateway-fixture")) {
  const gatewayFixture = process.argv.includes("--gateway-fixture");
  const api = gatewayFixture ? await import(`data:text/javascript;base64,${Buffer.from(fixtureHttp).toString("base64")}`) : null;
  const { workers } = await readBuildOutput(root);
  const built = workers.default;
  const config = convertToWranglerConfig({ worker: built.config, containers: [] });
  const worker = new Miniflare({
    ...base, modules: true, scriptPath: resolve(built.bundleDir, built.config.manifest.mainModule),
    modulesRules: [{type: "ESModule", include: ["**/*.js", "**/*.mjs"], fallthrough: true}],
    bindings: config.vars, inspectorPort: 9235,
    ...(gatewayFixture ? {outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.hostname, "6emaw-iyaaa-aaaay-aacka-cai.icp0.io");
      assert.ok(url.pathname.startsWith("/api/wiki-seo/"), "Worker must use HTTP instead of ICP query calls");
      const [id,...segments] = url.pathname.slice("/api/wiki-seo/".length).split("/");
      const mapped = id === "db_nnoe2kborlsq" ? "db_normal" : id;
      const data = await api.fetchPublicSeoPayload("fixture",mapped,`/${segments.map(decodeURIComponent).join("/")}`);
      if (!data) return new Response("null",{status:404});
      if (id === "db_nnoe2kborlsq") data.node.content += " 2025-12";
      return Response.json(data, {headers:{"cache-control":"no-store"}});
    }} : {})
  });
  let socket;
  try {
    const inspector = await worker.getInspectorURL();
    inspector.protocol = "http:";
    const targets = await (await fetch(new URL("/json/list", inspector))).json();
    const WebSocket = require("ws");
    socket = new WebSocket(targets[0].webSocketDebuggerUrl, {headers: {Origin: inspector.origin}});
    await new Promise((ok, fail) => {socket.once("open", ok); socket.once("error", fail);});
    let sequence = 0;
    const pending = new Map();
    socket.on("message", raw => {
      const message = JSON.parse(raw);
      if (!pending.has(message.id)) return;
      const {ok, fail} = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(JSON.stringify(message.error))); else ok(message.result);
    });
    const send = (method, params = {}) => new Promise((ok, fail) => {
      const id = ++sequence; pending.set(id, {ok, fail}); socket.send(JSON.stringify({id, method, params}));
    });
    await send("Profiler.enable");
    await send("Profiler.setSamplingInterval", {interval: 100});
    await send("Profiler.start");
    for (const concurrency of [1, 5]) {
      const durations = [];
      for (let batch = 0; batch < 20 / concurrency; batch++) {
        await Promise.all(Array.from({length: concurrency}, async () => {
          const start = performance.now();
          const response = await worker.dispatchFetch("https://wiki.kinic.xyz/db/db_nnoe2kborlsq/Knowledge/months/2025-12.md");
          const html = await response.text();
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("cache-control"), "no-store");
          assert.ok(html.includes("wiki-seo-document"), "Missing public article: check build-time VITE variables and live connectivity");
          assert.ok(html.includes("2025-12"));
          durations.push(performance.now() - start);
        }));
      }
      durations.sort((a,b) => a-b);
      results.live.push({concurrency, count: durations.length, wallP95Ms: durations[18], status: 200, article: true, cacheControl: "no-store"});
    }
    const {profile} = await send("Profiler.stop");
    await writeFile(resolve(output, "live.cpuprofile"), JSON.stringify(profile));
    if (gatewayFixture) {
      for (const id of ["db_long","db_table","db_unsafe","db_folder","db_private","db_missing"]) {
        const response = await worker.dispatchFetch(`https://wiki.kinic.xyz/db/${id}/Knowledge`);
        const html = await response.text();
        assert.equal(response.status,200);
        assert.equal(response.headers.get("cache-control"),"no-store");
        assert.equal(html.includes("wiki-seo-document"),!["db_private","db_missing"].includes(id));
        assert.ok(!html.includes("TAILSENTINEL"));
      }
      results.gatewayFixture = "passed: complete router and SSR with fixture HTTP responses; no ICP query subrequests";
    }
    for (const path of ["/db/db_miniflare_nonexistent/Knowledge", "/db/db_nnoe2kborlsq/search"]) {
      const response = await worker.dispatchFetch(`https://wiki.kinic.xyz${path}`);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.ok(!html.includes("wiki-seo-document"));
      results.live.push({path, status: 200, article: false, cacheControl: "no-store"});
    }
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    const counts = new Map();
    for (const sample of profile.samples ?? []) {
      const frame = nodes.get(sample).callFrame;
      const name = `${frame.functionName} ${frame.url}`;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    results.profileTopSamples = [...counts].sort((a,b) => b[1]-a[1]).slice(0, 20).map(([name, samples]) => ({name, samples}));
  } finally { socket?.terminate(); await worker.dispose(); }
}
await writeFile(resolve(output, "report.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
