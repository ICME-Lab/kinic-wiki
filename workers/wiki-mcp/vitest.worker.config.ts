import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./tests/auth-worker-entry.ts",
      wrangler: { configPath: "./wrangler.staging.jsonc" },
      miniflare: {
        bindings: {
          MCP_KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        }
      }
    })
  ],
  test: {
    include: ["tests/auth.worker.test.ts"]
  }
});
