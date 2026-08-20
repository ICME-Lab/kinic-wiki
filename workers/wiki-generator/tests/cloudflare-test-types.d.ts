// Minimal structural platform doubles for Node-based unit tests.
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
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
}

interface Fetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

type R2PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob;

type R2PutOptions = {
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
  };
  customMetadata?: Record<string, string>;
};

interface R2Bucket {
  put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<unknown>;
}

interface Message<T = unknown> {
  readonly id: string;
  readonly attempts: number;
  readonly body: T;
  retry(options?: { delaySeconds?: number }): void;
  ack(): void;
}

interface MessageBatch<T = unknown> {
  readonly messages: readonly Message<T>[];
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type ExportedHandler<EnvType = Env, QueueBody = unknown> = {
  fetch?(request: Request, env: EnvType, ctx: ExecutionContext): Response | Promise<Response>;
  queue?(batch: MessageBatch<QueueBody>, env: EnvType, ctx: ExecutionContext): void | Promise<void>;
  scheduled?(controller: ScheduledController, env: EnvType, ctx: ExecutionContext): void | Promise<void>;
};

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

declare module "crypto" {
  namespace webcrypto {
    interface SubtleCrypto {
      timingSafeEqual(left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView): boolean;
    }
  }
}
