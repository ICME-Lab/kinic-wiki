import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { enqueueSourceJob, claimSourceJob } from "../src/jobs.js";
import { runManual } from "../src/processing.js";
import { TestVfsClient, TestQueue, testEnv } from "./source-capture-fixtures.js";
import type { SourceQueueMessage } from "../src/types.js";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync("migrations").filter(name => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(`migrations/${name}`, "utf8"));
  }
  const db = { prepare(sql: string) { return { bind(...values: (string | number | null)[]) {
    return {
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async run() { return sqlite.prepare(sql).run(...values); }
    };
  } }; } } as unknown as D1Database;
  return { sqlite, db };
}
const message: SourceQueueMessage = { kind: "source", databaseId: "db_1", sourcePath: "/Sources/web/a.md", sourceEtag: "etag-1", targetRoot: "/Knowledge/web" };

test("same source version rejects a different generation folder before queueing", async () => {
  const { sqlite, db } = database();
  try {
    const queue = new TestQueue();
    const env = { ...testEnv(queue), DB: db };
    await enqueueSourceJob(env, message);
    await assert.rejects(enqueueSourceJob(env, { ...message, targetRoot: "/Knowledge/other" }), /source_target_conflict/);
    assert.equal(queue.messages.length, 1);
    assert.equal(sqlite.prepare("SELECT requested_target_root FROM source_jobs").get()?.requested_target_root, "/Knowledge/web");
  } finally { sqlite.close(); }
});

test("completed source version conflicts with a new folder but skips the same folder", async () => {
  const { sqlite, db } = database();
  try {
    const env = { ...testEnv(new TestQueue()), DB: db };
    await enqueueSourceJob(env, message);
    sqlite.exec("UPDATE source_jobs SET status = 'completed', target_path = '/Knowledge/web/a.md'");
    await assert.rejects(enqueueSourceJob(env, { ...message, targetRoot: "/Knowledge/other" }), /source_target_conflict/);
    assert.equal(await enqueueSourceJob(env, message), false);
    assert.equal(await enqueueSourceJob(env, { ...message, sourceEtag: "etag-2", targetRoot: "/Knowledge/other" }), true);
  } finally { sqlite.close(); }
});

test("competing destination submissions keep the first reservation and reject a forged queue body", async () => {
  const { sqlite, db } = database();
  try {
    const queue = new TestQueue();
    const env = { ...testEnv(queue), DB: db };
    const results = await Promise.allSettled([
      enqueueSourceJob(env, message),
      enqueueSourceJob(env, { ...message, targetRoot: "/Knowledge/other" })
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(queue.messages.length, 1);
    const claim = await claimSourceJob(db, { ...message, targetRoot: "/Knowledge/other" }, "owner");
    assert.equal(claim.kind, "destination_conflict");
    assert.equal(sqlite.prepare("SELECT status FROM source_jobs").get()?.status, "queued");
  } finally { sqlite.close(); }
});

test("legacy requests remain compatible and cannot silently replace an explicit destination", async () => {
  const { sqlite, db } = database();
  try {
    const env = { ...testEnv(new TestQueue()), DB: db };
    const legacy = { ...message, targetRoot: undefined };
    await enqueueSourceJob(env, legacy);
    assert.equal((await claimSourceJob(db, legacy, "owner")).kind, "generate");
    await assert.rejects(enqueueSourceJob(env, message), /source_target_conflict/);
    assert.equal(sqlite.prepare("SELECT requested_target_root FROM source_jobs").get()?.requested_target_root, null);
  } finally { sqlite.close(); }
});

test("failed jobs retain their destination and allow retries only for that destination", async () => {
  const { sqlite, db } = database();
  try {
    const env = { ...testEnv(new TestQueue()), DB: db };
    await enqueueSourceJob(env, message);
    sqlite.exec("UPDATE source_jobs SET status = 'failed'");
    await assert.rejects(enqueueSourceJob(env, { ...message, targetRoot: "/Knowledge/other" }), /source_target_conflict/);
    assert.equal(sqlite.prepare("SELECT status FROM source_jobs").get()?.status, "failed");
    assert.equal(await enqueueSourceJob(env, message), true);
    assert.equal(sqlite.prepare("SELECT status FROM source_jobs").get()?.status, "queued");
  } finally { sqlite.close(); }
});

test("manual API reports a conflicting destination as HTTP 409", async () => {
  const { sqlite, db } = database();
  try {
    const env = { ...testEnv(new TestQueue()), DB: db };
    await enqueueSourceJob(env, message);
    const vfs = new TestVfsClient();
    vfs.existingSource = { path: message.sourcePath, kind: "source", content: "raw", etag: message.sourceEtag, metadataJson: "{}" };
    const response = await runManual(env, { ...message, targetRoot: "/Knowledge/other", dryRun: false }, { vfs });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "source_target_conflict" });
  } finally { sqlite.close(); }
});
