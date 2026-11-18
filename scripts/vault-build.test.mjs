import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
const scratch = mkdtempSync(join(tmpdir(), "vault-build-test-"));
const binary = join(scratch, "vault-build");
execFileSync("rustc", ["--edition=2024", resolve("crates/vault_canister/build.rs"), "-o", binary]);
function fixture(embedded, assets = {}, overrides = {}) {
 const root = mkdtempSync(join(scratch, "case-"));
 const manifest = join(root,"crates/vault_canister"), out=join(root,"out");
 mkdirSync(manifest,{recursive:true});mkdirSync(out);
 for(const [name,contents] of Object.entries(assets)) { const path=join(root,"vaultbrowser/dist",name);mkdirSync(join(path,".."),{recursive:true});writeFileSync(path,contents); }
 const env={...process.env,CARGO_MANIFEST_DIR:manifest,OUT_DIR:out,CARGO_CFG_TARGET_ARCH:"wasm32"};
 for (const name of ["VAULT_LOCAL_WIKI_ORIGIN","VAULT_LOCAL_ORIGIN","VAULT_LOCAL_HOST","VAULT_LOCAL_II"]) delete env[name];
 Object.assign(env, overrides);
 delete env.CARGO_FEATURE_EMBEDDED_ASSETS;
 if(embedded)env.CARGO_FEATURE_EMBEDDED_ASSETS="1";
 return {result:spawnSync(binary,[],{env,encoding:"utf8"}),out};
}
test("backend Wasm builds without browser assets",()=>{const f=fixture(false);assert.equal(f.result.status,0,f.result.stderr);assert.match(readFileSync(join(f.out,"assets.rs"),"utf8"),/=&\[\s*\];/);});
test("asset feature refuses a missing browser build",()=>{const f=fixture(true);assert.notEqual(f.result.status,0);assert.match(f.result.stderr,/build|assets|index/);});
test("asset feature refuses incomplete browser assets",()=>{const f=fixture(true,{"orphan.js":"1"});assert.notEqual(f.result.status,0);assert.match(f.result.stderr,/index/);});
test("asset feature refuses an empty entrypoint",()=>{const f=fixture(true,{"index.html":"","assets/app.js":"1"});assert.notEqual(f.result.status,0);});
test("distribution embeds build provenance",()=>{const f=fixture(true,{"index.html":'<script src="/assets/app.js"></script>',"assets/app.js":"1"});assert.equal(f.result.status,0,f.result.stderr);assert.match(readFileSync(join(f.out,"assets.rs"),"utf8"),/kinic:vault-build/);});
test("asset feature embeds a complete browser build",()=>{const f=fixture(true,{"index.html":'<script src="/assets/app.js"></script>',"assets/app.js":"console.log(1)"});assert.equal(f.result.status,0,f.result.stderr);assert.match(readFileSync(join(f.out,"assets.rs"),"utf8"),/index.html/);});
test("validates the explicit local Wiki origin before embedding certified assets", () => {
 const assets = {"index.html":'<script src="/assets/app.js"></script>', "assets/app.js":"1"};
 const wiki = "http://wiki.localhost:3025";
 const local = { VAULT_LOCAL_ORIGIN: "http://vault.localhost:8024" };
 const build = (origin, env = local) => fixture(true, assets, {...env, VAULT_LOCAL_WIKI_ORIGIN: origin});
 const valid = build(wiki);
 assert.equal(valid.result.status, 0, valid.result.stderr);
 assert.match(valid.result.stdout,/rerun-if-env-changed=VAULT_LOCAL_WIKI_ORIGIN/);
 const source = readFileSync(join(valid.out,"assets.rs"),"utf8");
 const metadata = source.match(/static VAULT_BUILD:[^=]+= \*b(".*");/)[1];
 assert.equal(JSON.parse(JSON.parse(metadata)).local, true);
 for (const origin of ["https://wiki.kinic.xyz", "http://localhost:0", "http://wiki.localhost:3025/#x", "http://user@wiki.localhost:3025", local.VAULT_LOCAL_ORIGIN, "http://wiki.localhost:03025"]) {
   const invalid = build(origin);
   assert.notEqual(invalid.result.status, 0, origin);
   assert.match(invalid.result.stderr, /canonical loopback/);
 }
 assert.notEqual(build(wiki, {}).result.status, 0);
});
test("production build wrapper rejects a local Wiki flag before any build", () => {
 const env = { ...process.env, VAULT_LOCAL_WIKI_ORIGIN:"http://wiki.localhost:3025" };
 delete env.ICP_ENVIRONMENT;
 const result = spawnSync("bash", ["scripts/build-vault-canister.sh"], { env, encoding:"utf8" });
 assert.equal(result.status, 1, result.stderr);
 assert.match(result.stderr,/Local Vault origins require ICP_ENVIRONMENT=local-vault/);
});
process.on("exit",()=>rmSync(scratch,{recursive:true,force:true}));
