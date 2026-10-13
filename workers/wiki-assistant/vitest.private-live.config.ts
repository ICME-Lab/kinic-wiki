import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/speed-accuracy.live.test.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
