// Where: workers/wiki-generator/src/index.ts
// What: Cloudflare Worker entrypoints for manual, source capture, and queue triggers.
// Why: Generation should run outside the wiki browser UI server.
import { isAuthorized } from "./auth.js";
import { parseManualRunInput, parseQueueMessageEnvelope, processQueueMessageEnvelope, runManual, type QueueDisposition } from "./processing.js";
import { parseSourceCaptureTriggerInput, SourceCaptureTriggerError, validateSourceCaptureTriggerInput } from "./source-capture.js";
import type { QueueMessage } from "./types.js";
import type { RuntimeEnv } from "./env.js";

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse({ ok: true }, 200);
    }
    if (request.method === "POST" && url.pathname === "/source-capture") {
      const authError = await workerAuthError(request, env);
      if (authError) return authError;
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400);
      }
      const input = parseSourceCaptureTriggerInput(body);
      if (typeof input === "string") {
        return jsonResponse({ error: input }, 400);
      }
      try {
        validateSourceCaptureTriggerInput(env, input);
      } catch (error) {
        const status = error instanceof SourceCaptureTriggerError ? error.status : 500;
        return jsonResponse({ error: errorMessage(error) }, status);
      }
      await env.WIKI_GENERATION_QUEUE.send({
        kind: "source_capture",
        canisterId: input.canisterId,
        databaseId: input.databaseId,
        requestPath: input.requestPath,
        sessionNonce: input.sessionNonce
      });
      return jsonResponse({ accepted: true, databaseId: input.databaseId, requestPath: input.requestPath }, 202);
    }
    if (request.method !== "POST" || url.pathname !== "/run") {
      return jsonResponse({ error: "not found" }, 404);
    }
    const authError = await workerAuthError(request, env);
    if (authError) return authError;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    const input = parseManualRunInput(body);
    if (typeof input === "string") {
      return jsonResponse({ error: input }, 400);
    }
    try {
      return await runManual(env, input);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 500);
    }
  },

  async queue(batch, env): Promise<void> {
    await processQueueBatchForTest(env, batch.messages);
  }
} satisfies ExportedHandler<RuntimeEnv, QueueMessage>;

type QueueProcessor = (
  envelope: ReturnType<typeof parseQueueMessageEnvelope>,
  execution: { leaseOwner: string; attempts: number }
) => Promise<QueueDisposition>;

export async function processQueueBatchForTest(
  env: RuntimeEnv,
  messages: readonly Message<QueueMessage>[],
  processor?: QueueProcessor
): Promise<void> {
    const entries = messages.map((message) => ({ message, envelope: parseQueueMessageEnvelope(message.body) }));
    const dispositions = new Map<Message<QueueMessage>, QueueDisposition>();

    for (const entry of entries) {
      if (entry.envelope.kind === "valid" && entry.envelope.message.kind === "source") continue;
      dispositions.set(entry.message, await processQueueEntry(env, entry.message, entry.envelope, processor));
    }

    const sourceEntries = entries.filter((entry) => entry.envelope.kind === "valid" && entry.envelope.message.kind === "source");
    const sourceResults = await Promise.allSettled(sourceEntries.map((entry) => processQueueEntry(env, entry.message, entry.envelope, processor)));
    for (let index = 0; index < sourceEntries.length; index++) {
      const entry = sourceEntries[index]!;
      const result = sourceResults[index]!;
      dispositions.set(
        entry.message,
        result.status === "fulfilled" ? result.value : retryForUnhandled(result.reason, entry.message.attempts)
      );
    }

    for (const entry of entries) {
      await applyDisposition(env, entry.message, entry.envelope, dispositions.get(entry.message) ?? retryForUnhandled("missing disposition", entry.message.attempts));
    }
  }

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

async function workerAuthError(request: Request, env: RuntimeEnv): Promise<Response | null> {
  if (!env.KINIC_WIKI_WORKER_TOKEN) {
    return jsonResponse({ error: "KINIC_WIKI_WORKER_TOKEN is required" }, 503);
  }
  if (!(await isAuthorized(request, env.KINIC_WIKI_WORKER_TOKEN))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const FINAL_APPLICATION_ATTEMPT = 5;

async function processQueueEntry(
  env: RuntimeEnv,
  message: Message<QueueMessage>,
  envelope: ReturnType<typeof parseQueueMessageEnvelope>,
  processor?: QueueProcessor
): Promise<QueueDisposition> {
  try {
    const execution = { leaseOwner: message.id, attempts: message.attempts };
    return processor ? await processor(envelope, execution) : await processQueueMessageEnvelope(env, envelope, undefined, execution);
  } catch (error) {
    return retryForUnhandled(error, message.attempts);
  }
}

async function applyDisposition(
  env: RuntimeEnv,
  message: Message<QueueMessage>,
  envelope: ReturnType<typeof parseQueueMessageEnvelope>,
  disposition: QueueDisposition
): Promise<void> {
  if (disposition.kind === "ack") {
    message.ack();
    return;
  }
  if (disposition.kind === "reschedule") {
    if (envelope.kind !== "valid" || envelope.message.kind !== "source") {
      message.retry({ delaySeconds: disposition.delaySeconds });
      return;
    }
    try {
      await env.WIKI_GENERATION_QUEUE.send(message.body, { delaySeconds: disposition.delaySeconds });
      console.warn(
        JSON.stringify({
          event: "wiki_generation_rescheduled",
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
    console.warn(JSON.stringify({ event: "wiki_generation_retry", messageId: message.id, attempt: message.attempts, code: disposition.code }));
    message.retry({ delaySeconds: disposition.delaySeconds });
    return;
  }

  const code = disposition.code;
  try {
    const parsed = envelope.kind === "valid" ? envelope.message : null;
    await env.WIKI_GENERATION_DLQ.send({
      messageId: message.id,
      messageKind: parsed?.kind ?? "invalid",
      databaseId: parsed?.databaseId,
      sourcePath: parsed?.kind === "source" ? parsed.sourcePath : undefined,
      sourceEtag: parsed?.kind === "source" ? parsed.sourceEtag : undefined,
      attempt: message.attempts,
      errorCode: code,
      failedAt: new Date().toISOString()
    });
    console.error(JSON.stringify({ event: "wiki_generation_dead_lettered", messageId: message.id, attempt: message.attempts, code }));
    message.ack();
  } catch {
    message.retry({ delaySeconds: 300 });
  }
}

function retryForUnhandled(error: unknown, attempts: number): QueueDisposition {
  return {
    kind: "retry",
    delaySeconds: Math.min(300, 15 * 2 ** Math.max(0, attempts - 1)),
    code: "queue_handler_unhandled",
    message: errorMessage(error)
  };
}
