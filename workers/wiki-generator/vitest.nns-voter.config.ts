import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["worker-tests/nns-voter-health.worker.test.ts"],
    poolOptions: {
      workers: {
        main: "./src/nns-voter.ts",
        wrangler: { configPath: "./wrangler.nns-voter.jsonc" }
      }
    }
  }
});
