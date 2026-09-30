import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/overview-database.live.test.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
