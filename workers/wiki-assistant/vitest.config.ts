import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
    exclude: ["tests/*.worker.test.ts", "tests/*.live.test.ts"],
  },
});
