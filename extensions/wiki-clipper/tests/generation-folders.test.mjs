import assert from "node:assert/strict";
import test from "node:test";
import * as vfs from "../src/vfs-actor.js";

test("folder choices include nested Knowledge folders without fetching document content", async () => {
  const calls = [];
  const actor = { async list_children({database_id, path}) {
    calls.push({ database_id, path });
    const nodes = path === "/Knowledge" ? [
      { path: "/Knowledge/projects", kind: { Folder: null }, has_children: true },
      { path: "/Knowledge/note.md", kind: { File: null }, has_children: false },
      { path: "/Knowledge/web", kind: { Directory: null }, has_children: false },
      { path: "/Sources/private", kind: { Folder: null }, has_children: true }
    ] : [{ path: "/Knowledge/projects/資料", kind: { Folder: null }, has_children: false }];
    return { Ok: nodes };
  } };
  assert.deepEqual(await vfs.listKnowledgeFoldersWithActor(actor, "db-test"), { folders: ["/Knowledge/projects", "/Knowledge/projects/資料", "/Knowledge/web"], truncated: false });
  assert.deepEqual(calls, [{database_id:"db-test",path:"/Knowledge"},{database_id:"db-test",path:"/Knowledge/projects"}]);
});
test("folder lookup reports database access failures", async () => {
  await assert.rejects(vfs.listKnowledgeFoldersWithActor({list_children: async () => ({Err:"access denied"})}, "db-test"), /access denied/);
});


test("folder limit retains 500 selectable folders and reports truncation", async () => {
  const calls = [];
  const actor = { async list_children(request) {
    calls.push(request.path);
    return { Ok: Array.from({ length: 501 }, (_, i) => ({
      path: `/Knowledge/folder-${i}`, kind: { Folder: null }, has_children: true
    })) };
  } };
  const result = await vfs.listKnowledgeFoldersWithActor(actor, "db-test");
  assert.equal(result.truncated, true);
  assert.equal(result.folders.length, 500);
  assert.ok(result.folders.includes("/Knowledge/folder-0"));
  assert.deepEqual(calls, ["/Knowledge"]);
});


test("exactly 500 leaf folders do not report missing choices", async () => {
  const result = await vfs.listKnowledgeFoldersWithActor({ async list_children() {
    return { Ok: Array.from({ length: 500 }, (_, i) => ({
      path: `/Knowledge/folder-${i}`, kind: { Folder: null }, has_children: false
    })) };
  } }, "db-test");
  assert.equal(result.truncated, false);
  assert.equal(result.folders.length, 500);
});
