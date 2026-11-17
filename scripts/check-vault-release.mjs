// Validate source-embedded build provenance and the actual distribution exports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export function validateRelease(info) {
 assert.equal(info?.embedded_assets,true,"Distribution requires embedded-assets");
 assert.equal(info.local,false,"Distribution must not contain local configuration");
 assert.equal(info.synthetic,false,"Synthetic funding is nondeployable");
 assert.ok(Number.isInteger(info.assets)&&info.assets>=2,"Distribution requires complete browser assets");
}
export function checkRelease(path) {
 const module=new WebAssembly.Module(readFileSync(path));
 const sections=WebAssembly.Module.customSections(module,"kinic:vault-build");
 assert.equal(sections.length,1,"Expected one source-embedded Vault build provenance section");
 const info=JSON.parse(new TextDecoder().decode(sections[0]));validateRelease(info);
 const exports=new Set(WebAssembly.Module.exports(module).map(x=>x.name));
 for(const name of ["canister_query http_request","canister_update reconcile_purchase","canister_update quote_purchase"])
  assert.ok(exports.has(name),`Distribution missing ${name}`);
 for(const name of exports)assert.ok(!name.includes("fixture_"),"Test controls are nondeployable");
 return info;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 assert.ok(process.argv[2],"Usage: node scripts/check-vault-release.mjs WASM");
 console.log(JSON.stringify(checkRelease(process.argv[2])));
}
