import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { loadTestConfig } from "../../scripts/cloudflare/test-config.mjs";
import { harfbuzzWorkers } from "./harfbuzz-workers-plugin";

const workerConfig = await loadTestConfig(import.meta.dirname);

export default defineConfig({
  plugins: [
    harfbuzzWorkers(),
    cloudflareTest({
      main: workerConfig.main,
      miniflare: {
        ...workerConfig.miniflare,
        // Match the production build, which bundles .wasm imports as precompiled modules.
        modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }]
      }
    })
  ],
  test: {
    include: ["worker-tests/**/*.test.ts"]
  }
});
