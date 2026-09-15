import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["PROBE_DB"],
        bindings: {
          TEST_MIGRATION: readFileSync(
            "./migrations/0001_assistant.sql",
            "utf8",
          ),
          ASSISTANT_ENABLED: "true",
          ASSISTANT_WEB_ENABLED: "true",
          ASSISTANT_NATIVE_ENABLED: "true",
          OPENAI_API_KEY: "test-not-a-real-key",
          ASSISTANT_KEY_ENCRYPTION_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    }),
  ],
  test: { include: ["tests/*.worker.test.ts"] },
});
