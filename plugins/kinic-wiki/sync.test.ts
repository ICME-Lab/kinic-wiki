import test from "node:test";
import assert from "node:assert/strict";

import { shouldSkipPush } from "./sync_logic";

test("push does not skip remote tombstones when only deletions are pending", () => {
  assert.equal(shouldSkipPush(0, 1), false);
  assert.equal(shouldSkipPush(1, 0), false);
  assert.equal(shouldSkipPush(0, 0), true);
});
