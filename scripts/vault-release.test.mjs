import test from "node:test";
import assert from "node:assert/strict";
import { validateRelease } from "./check-vault-release.mjs";
const good={embedded_assets:true,local:false,synthetic:false,assets:2};
test("release accepts production embedded assets",()=>assert.doesNotThrow(()=>validateRelease(good)));
for(const [name,patch] of Object.entries({backend:{embedded_assets:false},local:{local:true},synthetic:{synthetic:true},empty:{assets:0}}))test(`release refuses ${name}`,()=>assert.throws(()=>validateRelease({...good,...patch})));
test("release refuses missing provenance",()=>assert.throws(()=>validateRelease(undefined)));
