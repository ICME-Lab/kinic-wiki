// Where: workers/wiki-generator/src/cloudflare-types.d.ts
// What: Minimal Cloudflare binding types used by the wiki generator worker.
// Why: Wrangler's generated runtime file is too large to commit for this worker.
type D1Value = string | number | boolean | null | Uint8Array;

interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface Queue<T = unknown> {
  send(message: T): Promise<void>;
}

interface Message<T = unknown> {
  body: T;
  ack(): void;
}

interface MessageBatch<T = unknown> {
  messages: Message<T>[];
}

interface ScheduledController {}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface Env {
  DB: D1Database;
  WIKI_GENERATION_QUEUE: Queue;
  KINIC_WIKI_CANISTER_ID: string;
  KINIC_WIKI_IC_HOST: string;
  KINIC_WIKI_WORKER_MODEL: string;
  KINIC_WIKI_WORKER_TARGET_ROOT: string;
  KINIC_WIKI_WORKER_SOURCE_PREFIX: string;
  KINIC_WIKI_WORKER_CONTEXT_PREFIX: string;
}

declare module "crypto" {
  namespace webcrypto {
    interface SubtleCrypto {
      timingSafeEqual(left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView): boolean;
    }
  }
}

type ExportedHandler<EnvType = Env, QueueBody = unknown> = {
  fetch?(request: Request, env: EnvType, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled?(controller: ScheduledController, env: EnvType, ctx: ExecutionContext): void | Promise<void>;
  queue?(batch: MessageBatch<QueueBody>, env: EnvType, ctx: ExecutionContext): void | Promise<void>;
};
