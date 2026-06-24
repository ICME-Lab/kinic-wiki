// Where: workers/wiki-generator/tests/wiki-skill.test.ts
// What: Core wiki rule prompt tests.
// Why: Generation must stay tied to wiki semantics, not Skill Registry packages.
import assert from "node:assert/strict";
import test from "node:test";
import { buildWikiDraftSystemPrompt } from "../src/wiki-skill.js";

test("core wiki prompt keeps source and wiki roles separate", () => {
  const prompt = buildWikiDraftSystemPrompt();
  assert.match(prompt, /Kinic Wiki Core Skill v1/);
  assert.match(prompt, /\/Sources/);
  assert.match(prompt, /\/Wiki/);
  assert.match(prompt, /Every generated item must cite/);
  assert.match(prompt, /source material's primary language/);
  assert.match(prompt, /section labels/);
  assert.match(prompt, /Section labels must be non-empty single-line strings/);
  assert.doesNotMatch(prompt, /Japanese/);
});
