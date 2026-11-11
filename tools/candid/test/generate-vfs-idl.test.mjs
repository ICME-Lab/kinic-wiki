import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateVfsIdlFromDid } from "../generate-vfs-idl.mjs";

test("production bindings include durable revision contracts with documented Candid fields", () => {
  const did=readFileSync(new URL("../../../crates/vfs_canister/vfs.did",import.meta.url),"utf8");
  const generated=generateVfsIdlFromDid(did);
  assert.match(generated,/current_node_revision: idl.Func/);
  assert.match(generated,/node_history: idl.Func/);
  assert.match(generated,/publish_learning: idl.Func/);
  assert.match(generated,/node_id: idl.Text/);
  assert.match(generated,/before_revision: idl.Opt\(idl.Nat64\)/);
  assert.equal(generated,readFileSync(new URL("../../../packages/vfs-candid/index.ts",import.meta.url),"utf8"));
});
