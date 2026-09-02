import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["worker-tests/**/*.test.ts"],
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" }
      }
    }
  }
});
