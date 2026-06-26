import assert from "node:assert/strict";
import { parseSmokeTargetUrl } from "./smoke-ui.mjs";

const databaseId = "db_k7p9x2mq4v8r";

assert.deepEqual(parseSmokeTargetUrl(`http://localhost:3000/db/${databaseId}/Knowledge/space%20name.md`), {
  origin: "http://localhost:3000",
  databaseId,
  nodePath: "/Knowledge/space name.md"
});
assert.deepEqual(parseSmokeTargetUrl(`http://localhost:3000/db/${databaseId}/Knowledge/%E3%81%82.md`), {
  origin: "http://localhost:3000",
  databaseId,
  nodePath: "/Knowledge/あ.md"
});
assert.deepEqual(parseSmokeTargetUrl(`http://localhost:3000/db/${databaseId}/Knowledge/100%25.md`), {
  origin: "http://localhost:3000",
  databaseId,
  nodePath: "/Knowledge/100%.md"
});
assert.deepEqual(parseSmokeTargetUrl(`http://localhost:3000/db/${databaseId}/Knowledge/bad%.md`), {
  origin: "http://localhost:3000",
  databaseId,
  nodePath: "/Knowledge/bad%.md"
});

console.log("Smoke URL checks OK");
