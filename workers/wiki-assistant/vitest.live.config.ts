import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "tests/deepseek-synthetic.live.test.ts",
      "tests/evaluation.live.test.ts",
      "tests/overview-routing.live.test.ts",
      "tests/overview-synthetic.live.test.ts",
    ],
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
