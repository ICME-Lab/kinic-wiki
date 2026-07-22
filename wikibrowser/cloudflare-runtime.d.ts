interface CloudflareEnv {
  DEEPSEEK_API_KEY?: string;
  KINIC_WIKI_CANISTER_ID: string;
  KINIC_WIKI_GENERATOR_URL?: string;
  KINIC_WIKI_WORKER_MODEL?: string;
  KINIC_WIKI_WORKER_TOKEN?: string;
  LINK_PREVIEW_IMAGES: {
    get(key: string): Promise<{ body: ReadableStream<Uint8Array> | null; httpEtag?: string; writeHttpMetadata?(headers: Headers): void } | null>;
    put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string, options?: unknown): Promise<void>;
  };
  LINK_PREVIEW_QUEUE: { send(message: unknown): Promise<void> };
  QUERY_ANSWER_RATE_LIMIT: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
  VITE_KINIC_WIKI_CANISTER_ID: string;
  VITE_WIKI_IC_HOST: string;
}

declare module "cloudflare:workers" {
  export const env: CloudflareEnv;
}
