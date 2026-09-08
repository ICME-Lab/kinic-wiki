import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["worker-tests/nns-health.worker.test.ts"],
    poolOptions: {
      workers: {
        main: "./src/nns-index.ts",
        wrangler: { configPath: "./wrangler.nns.jsonc" }
      }
    }
  }
});
