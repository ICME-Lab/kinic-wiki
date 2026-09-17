import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtimeRequire = createRequire(
  import.meta.resolve("@cloudflare/vitest-pool-workers"),
);
const { Miniflare } = runtimeRequire("miniflare");
const [initialMigration, chargeMigration] = await Promise.all(
  ["0001_assistant.sql", "0002_charge_conversation.sql"].map((name) =>
    readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
  ),
);
const executableChargeMigration = chargeMigration.replace(/\s+/g, " ");
const cleanup = JSON.stringify({
  cleanup: [
    {
      conversationId: "conversation-from-cleanup",
      voiceUsage: { chargeId: "cleanup-charge" },
    },
  ],
  charges: [
    { id: "active-charge" },
    { id: "cleanup-charge" },
    { id: "stopped-charge" },
    { id: "orphan-charge" },
    { id: "null-charge", conversationId: null },
    { id: "modern-charge", conversationId: "already-current" },
  ],
});
const seed = `INSERT INTO assistant_users(principal,revision,commit_id,conversation_id,auth_id,voice_id,data,usage_day,questions,voice_seconds,seen,activity,next_attempt,attempts) VALUES ('owner',0,'commit','active-conversation','auth','active-charge',NULL,'2026-09-17',0,0,0,0,0,0); INSERT INTO assistant_cleanup(principal,data) VALUES ('owner','${cleanup}'); INSERT INTO assistant_stops(conversation_id,voice_id,stopped_at) VALUES ('conversation-from-stop','stopped-charge',1);`;
const script = `export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/init') {
    await env.DB.exec(${JSON.stringify(initialMigration)});
    await env.DB.exec(${JSON.stringify(seed)});
    return new Response('initialized');
  }
  if (path === '/migrate') {
    await env.DB.exec(${JSON.stringify(executableChargeMigration)});
    return new Response('migrated');
  }
  const row = await env.DB.prepare("SELECT data FROM assistant_cleanup WHERE principal='owner'").first();
  return Response.json(JSON.parse(row.data));
}};`;

test("charge migration assigns durable conversation ownership once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-migration-"));
  const runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-08-08",
    d1Databases: { DB: "assistant-migration-test" },
    resourcePersistencePath: directory,
  });
  try {
    const initialized = await runtime.dispatchFetch("https://test/init");
    assert.equal(initialized.status, 200, await initialized.text());
    const migrated = await runtime.dispatchFetch("https://test/migrate");
    assert.equal(migrated.status, 200, await migrated.text());
    const migratedAgain = await runtime.dispatchFetch("https://test/migrate");
    assert.equal(migratedAgain.status, 200, await migratedAgain.text());
    const state = await (
      await runtime.dispatchFetch("https://test/state")
    ).json();
    assert.deepEqual(
      Object.fromEntries(
        state.charges.map((charge) => [charge.id, charge.conversationId]),
      ),
      {
        "active-charge": "active-conversation",
        "cleanup-charge": "conversation-from-cleanup",
        "stopped-charge": "conversation-from-stop",
        "orphan-charge": "legacy:orphan-charge",
        "null-charge": "legacy:null-charge",
        "modern-charge": "already-current",
      },
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
