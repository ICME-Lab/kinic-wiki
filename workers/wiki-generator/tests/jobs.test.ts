// Where: workers/wiki-generator/tests/jobs.test.ts
// What: Job idempotency tests.
// Why: Retries must not reprocess an unchanged completed source.
import assert from "node:assert/strict";
import test from "node:test";
import { checkpointGenerated, checkpointGeneratedTarget, claimSourceJob, markCompleted, shouldSkipJob } from "../src/jobs.js";
import type { SourceJob, SourceQueueMessage } from "../src/types.js";

const completedJob: SourceJob = {
  database_id: "db_1",
  source_path: "/Sources/a/a.md",
  source_etag: "etag-1",
  status: "completed",
  target_path: "/Knowledge/conversations/a.md",
  attempts: 1,
  last_error: null,
  lease_owner: null,
  lease_expires_at: null,
  generated_target_path: null,
  generated_target_etag: null,
  generated_target_observed: 0,
  generated_content: null,
  generated_context_paths: null,
  llm_duration_ms: null,
  updated_at: "2026-05-12T00:00:00.000Z"
};

test("same completed etag is skipped", () => {
  assert.equal(shouldSkipJob(completedJob, "etag-1"), true);
});

test("changed etag or failed status is not skipped", () => {
  assert.equal(shouldSkipJob(completedJob, "etag-2"), false);
  assert.equal(shouldSkipJob({ ...completedJob, status: "failed" }, "etag-1"), false);
});

test("atomic lease claim starts one generation and treats an active duplicate as busy", async () => {
  const message = sourceMessage();
  const claimed = { ...completedJob, status: "processing" as const, target_path: null, lease_owner: "owner-1", lease_expires_at: "2026-07-16T00:05:00.000Z" };
  const firstDb = new ScriptedD1([claimed]);

  assert.deepEqual(await claimSourceJob(firstDb, message, "owner-1", new Date("2026-07-16T00:00:00.000Z")), { kind: "generate" });
  assert.match(firstDb.queries[0] ?? "", /UPDATE source_jobs/);
  assert.match(firstDb.queries[0] ?? "", /lease_expires_at <= \?6/);
  assert.match(firstDb.queries[0] ?? "", /RETURNING/);

  const duplicateDb = new ScriptedD1([null, claimed]);
  assert.deepEqual(await claimSourceJob(duplicateDb, message, "owner-2", new Date("2026-07-16T00:01:00.000Z")), {
    kind: "busy",
    retryAfterSeconds: 241
  });
});

test("expired lease can be atomically reclaimed", async () => {
  const reclaimed = {
    ...completedJob,
    status: "processing" as const,
    target_path: null,
    lease_owner: "owner-2",
    lease_expires_at: "2026-07-16T00:11:00.000Z"
  };
  const db = new ScriptedD1([reclaimed]);

  assert.deepEqual(await claimSourceJob(db, sourceMessage(), "owner-2", new Date("2026-07-16T00:06:00.000Z")), { kind: "generate" });
});

test("generated checkpoint resumes without regeneration", async () => {
  const generated: SourceJob = {
    ...completedJob,
    status: "generated",
    target_path: null,
    lease_owner: "owner-2",
    lease_expires_at: "2026-07-16T00:11:00.000Z",
    generated_target_path: "/Knowledge/conversations/project.md",
    generated_target_etag: "etag-old-target",
    generated_target_observed: 1,
    generated_content: "# Project",
    generated_context_paths: '["/Knowledge/context.md"]',
    llm_duration_ms: 1234
  };
  const db = new ScriptedD1([generated]);

  assert.deepEqual(await claimSourceJob(db, sourceMessage(), "owner-2", new Date("2026-07-16T00:06:00.000Z")), {
    kind: "resume",
    artifact: {
      targetPath: "/Knowledge/conversations/project.md",
      expectedTargetEtag: "etag-old-target",
      content: "# Project",
      contextPaths: ["/Knowledge/context.md"],
      llmDurationMs: 1234
    }
  });
});

test("generated checkpoint without a target snapshot also resumes without regeneration", async () => {
  const generated: SourceJob = {
    ...completedJob,
    status: "generated",
    target_path: null,
    lease_owner: "owner-2",
    lease_expires_at: "2026-07-16T00:11:00.000Z",
    generated_target_path: "/Knowledge/conversations/project.md",
    generated_target_observed: 0,
    generated_content: "# Project",
    generated_context_paths: "[]",
    llm_duration_ms: 1234
  };
  const db = new ScriptedD1([generated]);

  assert.deepEqual(await claimSourceJob(db, sourceMessage(), "owner-2", new Date("2026-07-16T00:06:00.000Z")), {
    kind: "resume",
    artifact: {
      targetPath: "/Knowledge/conversations/project.md",
      expectedTargetEtag: undefined,
      content: "# Project",
      contextPaths: [],
      llmDurationMs: 1234
    }
  });
});

test("wrong etag is superseded and wrong checkpoint owner is rejected", async () => {
  const newer = { ...completedJob, source_etag: "etag-new" };
  const claimDb = new ScriptedD1([null, newer]);
  const claim = await claimSourceJob(claimDb, sourceMessage(), "owner-old");
  assert.equal(claim.kind, "superseded");

  const checkpointDb = new ScriptedD1([null]);
  await assert.rejects(
    checkpointGenerated(checkpointDb, sourceMessage(), "wrong-owner", {
      targetPath: "/Knowledge/conversations/project.md",
      expectedTargetEtag: null,
      content: "# Project",
      contextPaths: [],
      llmDurationMs: 1
    }),
    /checkpoint lease was lost/
  );
});

test("completion clears checkpoint content but retains LLM duration", async () => {
  const db = new ScriptedD1([{ database_id: "db_1" }]);

  await markCompleted(db, sourceMessage(), "owner-1", "/Knowledge/conversations/project.md");

  assert.match(db.queries[0] ?? "", /generated_content = NULL/);
  assert.doesNotMatch(db.queries[0] ?? "", /llm_duration_ms = NULL/);
});

test("target snapshot is appended to an existing generated checkpoint", async () => {
  const db = new ScriptedD1([{ database_id: "db_1" }]);

  await checkpointGeneratedTarget(db, sourceMessage(), "owner-1", "etag-target");

  assert.match(db.queries[0] ?? "", /generated_target_etag = \?4/);
  assert.match(db.queries[0] ?? "", /generated_target_observed = 1/);
});

function sourceMessage(): SourceQueueMessage {
  return { kind: "source", databaseId: "db_1", sourcePath: "/Sources/a/a.md", sourceEtag: "etag-1" };
}

class ScriptedD1 implements D1Database {
  readonly queries: string[] = [];
  private readonly responses: unknown[];

  constructor(responses: unknown[]) {
    this.responses = [...responses];
  }

  prepare(query: string): D1PreparedStatement {
    this.queries.push(query);
    return new ScriptedStatement(this.responses);
  }
}

class ScriptedStatement implements D1PreparedStatement {
  constructor(private readonly responses: unknown[]) {}

  bind(): D1PreparedStatement {
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.responses.shift() ?? null) as T | null;
  }

  async run(): Promise<unknown> {
    return {};
  }
}
