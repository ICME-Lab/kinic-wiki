// Where: scripts/strip-ts-for-test.mjs
// What: Minimal TypeScript-to-JavaScript transform for Node-based repository checks.
// Why: TypeScript 7 does not expose the legacy compiler API used by these tests.
import { stripTypeScriptTypes } from "node:module";

export function stripTsForTest(source) {
  return stripTypeScriptTypes(source, {
    mode: "transform",
    sourceMap: false
  });
}

export async function importStrippedTsForTest(source) {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(stripTsForTest(source)).toString("base64")}`;
  return import(moduleUrl);
}
