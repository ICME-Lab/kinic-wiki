import { defineConfig } from "@playwright/test";

const wikiOrigin = "http://127.0.0.1:3016";

export default defineConfig({
  testDir: ".",
  outputDir: "../../test-results/vault-reference",
  testMatch: "*.spec.ts",
  use: { baseURL: wikiOrigin, trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec vite --config fixtures/vault-reference/vite.config.ts",
    cwd: new URL("../..", import.meta.url).pathname,
    url: wikiOrigin,
    reuseExistingServer: false
  }
});
