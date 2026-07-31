import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["tests/auth.worker.test.ts"],
    poolOptions: {
      workers: {
        main: "./tests/auth-worker-entry.ts",
        wrangler: { configPath: "./wrangler.staging.jsonc" },
        miniflare: {
          bindings: {
            MCP_KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
          }
        }
      }
    }
  }
});
