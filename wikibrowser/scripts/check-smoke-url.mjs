import assert from "node:assert/strict";
import { parseSmokeTargetUrl } from "./smoke-ui.mjs";

const databaseId = "db_k7p9x2mq4v8r";

assert.deepEqual(parseSmokeTargetUrl(`http://localhost:3000/db/${databaseId}/Wiki/space%20name.md`), {
  origin: "http://localhost:3000",
  databaseId,
  nodePath: "/Wiki/space name.md"
});
assert.deepEqual(parseSmokeTargetUrl(`http://localhost:3000/db/${databaseId}/Wiki/%E3%81%82.md`), {
  origin: "http://localhost:3000",
  databaseId,
  nodePath: "/Wiki/あ.md"
});
assert.deepEqual(parseSmokeTargetUrl(`http://localhost:3000/db/${databaseId}/Wiki/100%25.md`), {
  origin: "http://localhost:3000",
  databaseId,
  nodePath: "/Wiki/100%.md"
});
assert.deepEqual(parseSmokeTargetUrl(`http://localhost:3000/db/${databaseId}/Wiki/bad%.md`), {
  origin: "http://localhost:3000",
  databaseId,
  nodePath: "/Wiki/bad%.md"
});

console.log("Smoke URL checks OK");
