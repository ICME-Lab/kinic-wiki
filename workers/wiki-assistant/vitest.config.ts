import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./tests/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/*.test.ts"],
    exclude: ["tests/*.worker.test.ts", "tests/*.live.test.ts"],
  },
});
