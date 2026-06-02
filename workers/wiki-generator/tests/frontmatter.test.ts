import assert from "node:assert/strict";
import test from "node:test";
import { parseFrontmatter } from "../src/frontmatter.js";

test("frontmatter parser requires a whole-line terminator", () => {
  const parsed = parseFrontmatter("---\nstatus: queued\n---not-a-terminator\nbody\n---\n# Body\n");
  assert.deepEqual(parsed?.fields, { status: "queued" });
  assert.equal(parsed?.body, "# Body\n");
});

test("frontmatter parser uses JSON-compatible double quoted scalars", () => {
  const parsed = parseFrontmatter("---\ntitle: \"quoted \\\"value\\\"\"\n---\n# Body\n");
  assert.equal(parsed?.fields.title, 'quoted "value"');
});
