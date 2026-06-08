import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT ?? 3100);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const localIiProviderURL = process.env.NEXT_PUBLIC_II_PROVIDER_URL ?? "http://id.ai.localhost:8011";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: {
    timeout: 15_000
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            `--unsafely-treat-insecure-origin-as-secure=${localIiProviderURL}`,
            `--unsafely-treat-insecure-origin-as-secure=${baseURL}`
          ]
        }
      }
    }
  ],
  webServer: {
    command: `NEXT_PUBLIC_WIKI_IC_HOST=${process.env.NEXT_PUBLIC_WIKI_IC_HOST ?? "http://127.0.0.1:8011"} NEXT_PUBLIC_ENABLE_LOCAL_II_E2E=1 NEXT_PUBLIC_II_PROVIDER_URL=${localIiProviderURL} NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=${process.env.NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID ?? ""} pnpm dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
