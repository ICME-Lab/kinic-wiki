import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../app/p/[publicId]/page.tsx", import.meta.url), "utf8");

assert.match(page, /aria-label="Kinic Wiki home"/, "public node page must link its brand to the home page");
assert.match(page, /src="\/kinic-mark\.png"/, "public node page must show the Kinic mark");
assert.equal((page.match(/href="\/dashboard"/g) ?? []).length, 2, "public node page must link both calls to action to the dashboard");
assert.equal((page.match(/Start using Kinic Wiki/g) ?? []).length, 2, "public node page must show the acquisition call to action twice");
assert.match(page, /Build your own AI memory with Kinic Wiki/);
assert.match(page, /Turn sources into durable, linked knowledge that agents can search, cite, and maintain\./);
assert.match(page, /Published with Kinic Wiki/, "public node page must retain the publication label");

console.log("Public node brand navigation and calls to action OK");
