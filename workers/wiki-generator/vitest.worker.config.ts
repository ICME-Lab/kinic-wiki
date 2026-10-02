import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { loadTestConfig } from "../../scripts/cloudflare/test-config.mjs";

const workerConfig = await loadTestConfig(import.meta.dirname);

export default defineConfig({
  plugins: [
    cloudflareTest({
      ...workerConfig
    })
  ],
  test: {
    include: ["worker-tests/**/*.test.ts"]
  }
});
