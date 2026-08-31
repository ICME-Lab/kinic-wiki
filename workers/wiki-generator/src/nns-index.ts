// Where: workers/wiki-generator/src/nns-index.ts
// What: Private service, scheduled, and Queue entrypoints for NNS proposal reviews.
// Why: NNS discovery, persistence, and generation require an isolated failure and deployment boundary.
import { getNnsAuditStatus, processNnsQueueMessage, runNnsAuditPoll } from "./nns-audit.js";
import type { NnsRuntimeEnv } from "./nns-env.js";
import { recordTerminalNnsDeliveryFailure } from "./nns-jobs.js";
import type { NnsProposalReviewQueueMessage } from "./types.js";
import type { QueueDisposition } from "./queue-types.js";

const FINAL_APPLICATION_ATTEMPT = 5;

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return jsonResponse({ ok: true }, 200);
    if (request.method === "GET" && url.pathname === "/status") {
      try {
        return jsonResponse(await getNnsAuditStatus(env), 200);
      } catch (error) {
        return jsonResponse({ error: errorMessage(error) }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/run") {
      const parsed = await parseRunOptions(request);
      if (parsed instanceof Response) return parsed;
      try {
        return jsonResponse(await runNnsAuditPoll(env, parsed), 200);
      } catch (error) {
        return jsonResponse({ error: errorMessage(error) }, 500);
      }
    }
    return jsonResponse({ error: "not found" }, 404);
  },

  async queue(batch, env): Promise<void> {
    await processNnsQueueBatchForTest(env, batch.messages);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      runNnsAuditPoll(env)
        .then((result) => {
          console.log(
            JSON.stringify({
              event: "nns_audit_poll_completed",
              enabled: result.enabled,
              initialized: result.initialized,
              discovered: result.discovered,
              enqueued: result.enqueued
            })
          );
        })
        .catch((error) => {
          console.error(JSON.stringify({ event: "nns_audit_poll_failed", error: errorMessage(error) }));
          throw error;
        })
    );
  }
} satisfies ExportedHandler<NnsRuntimeEnv, NnsProposalReviewQueueMessage>;

type NnsQueueProcessor = (
  message: NnsProposalReviewQueueMessage,
  execution: { leaseOwner: string; attempts: number }
) => Promise<QueueDisposition>;

export async function processNnsQueueBatchForTest(
  env: NnsRuntimeEnv,
  messages: readonly Message<unknown>[],
  processor: NnsQueueProcessor = (message, execution) => processNnsQueueMessage(env, message, execution)
): Promise<void> {
  const results = await Promise.allSettled(
    messages.map(async (message) => {
      const parsed = parseNnsQueueMessage(message.body);
      if (!parsed) return { message, parsed: null, disposition: deadLetter("nns_queue_message_invalid", "NNS queue message is invalid") };
      try {
        const disposition = await processor(parsed, { leaseOwner: message.id, attempts: message.attempts });
        return { message, parsed, disposition };
      } catch (error) {
        return { message, parsed, disposition: await dispositionForUnhandled(env, parsed, message, error) };
      }
    })
  );
  for (let index = 0; index < messages.length; index += 1) {
    const result = results[index]!;
    if (result.status === "rejected") {
      const message = messages[index]!;
      const parsed = parseNnsQueueMessage(message.body);
      const disposition = parsed ? await dispositionForUnhandled(env, parsed, message, result.reason) : deadLetter("nns_queue_message_invalid", "NNS queue message is invalid");
      await applyDisposition(env, message, parsed, disposition);
    } else {
      await applyDisposition(env, result.value.message, result.value.parsed, result.value.disposition);
    }
  }
}

export function parseNnsQueueMessage(value: unknown): NnsProposalReviewQueueMessage | null {
  if (!isObject(value) || value.kind !== "nns_proposal_review") return null;
  if (typeof value.databaseId !== "string" || !value.databaseId.trim() || value.databaseId.length > 128) return null;
  if (typeof value.proposalId !== "number" || !Number.isSafeInteger(value.proposalId) || value.proposalId < 1) return null;
  return { kind: "nns_proposal_review", databaseId: value.databaseId, proposalId: value.proposalId };
}

async function applyDisposition(
  env: NnsRuntimeEnv,
  message: Message<unknown>,
  parsed: NnsProposalReviewQueueMessage | null,
  disposition: QueueDisposition
): Promise<void> {
  if (disposition.kind === "ack") {
    message.ack();
    return;
  }
  if (disposition.kind === "reschedule" && parsed) {
    try {
      await env.NNS_PROPOSAL_REVIEW_QUEUE.send(parsed, { delaySeconds: disposition.delaySeconds });
      console.warn(
        JSON.stringify({
          event: "nns_proposal_review_rescheduled",
          messageId: message.id,
          attempt: message.attempts,
          code: disposition.code,
          delaySeconds: disposition.delaySeconds
        })
      );
      message.ack();
    } catch {
      message.retry({ delaySeconds: disposition.delaySeconds });
    }
    return;
  }
  if (disposition.kind === "retry" && message.attempts < FINAL_APPLICATION_ATTEMPT) {
    console.warn(JSON.stringify({ event: "nns_proposal_review_retry", messageId: message.id, attempt: message.attempts, code: disposition.code }));
    message.retry({ delaySeconds: disposition.delaySeconds });
    return;
  }
  try {
    await env.NNS_PROPOSAL_REVIEW_DLQ.send({
      messageId: message.id,
      messageKind: parsed?.kind ?? "invalid",
      databaseId: parsed?.databaseId,
      proposalId: parsed?.proposalId,
      attempt: message.attempts,
      errorCode: disposition.code,
      failedAt: new Date().toISOString()
    });
    console.error(
      JSON.stringify({ event: "nns_proposal_review_dead_lettered", messageId: message.id, attempt: message.attempts, code: disposition.code })
    );
    message.ack();
  } catch {
    message.retry({ delaySeconds: 300 });
  }
}

async function parseRunOptions(request: Request): Promise<{ retryFailed: boolean } | Response> {
  try {
    const text = await request.text();
    if (!text.trim()) return { retryFailed: false };
    const body: unknown = JSON.parse(text);
    if (!isObject(body) || (body.retryFailed !== undefined && typeof body.retryFailed !== "boolean")) {
      return jsonResponse({ error: "retryFailed must be a boolean" }, 400);
    }
    return { retryFailed: body.retryFailed === true };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
}

async function dispositionForUnhandled(
  env: NnsRuntimeEnv,
  parsed: NnsProposalReviewQueueMessage,
  message: Message<unknown>,
  error: unknown
): Promise<QueueDisposition> {
  const delaySeconds = retryDelay(message.attempts);
  if (message.attempts < FINAL_APPLICATION_ATTEMPT) {
    return retryForUnhandled(error, message.attempts);
  }
  try {
    const result = await recordTerminalNnsDeliveryFailure(env.DB, parsed, message.id, errorMessage(error));
    if (result === "failed" || result === "already_failed" || result === "missing") {
      return deadLetter("nns_queue_handler_unhandled", errorMessage(error));
    }
    return {
      kind: "reschedule",
      delaySeconds,
      code: result === "completed" ? "nns_completed_index_retry" : "nns_job_busy",
      message: errorMessage(error)
    };
  } catch {
    return { kind: "reschedule", delaySeconds, code: "nns_terminal_state_unknown", message: "NNS terminal state could not be persisted" };
  }
}

function retryForUnhandled(error: unknown, attempts: number): QueueDisposition {
  return {
    kind: "retry",
    delaySeconds: retryDelay(attempts),
    code: "nns_queue_handler_unhandled",
    message: errorMessage(error)
  };
}

function retryDelay(attempts: number): number {
  return Math.min(300, 15 * 2 ** Math.max(0, attempts - 1));
}

function deadLetter(code: string, message: string): QueueDisposition {
  return { kind: "dead_letter", code, message };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
