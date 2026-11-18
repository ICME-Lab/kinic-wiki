import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { assertCreditBridgeBuild } from "@kinic/credit-bridge-candid/build-guard";

export default defineConfig(({ command, mode }) => {
  assertCreditBridgeBuild(command, mode, { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env });
  return {
  server: { host: "127.0.0.1", port: 3010 },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: { path: ".wrangler/state" },
      experimental: { newConfig: { types: { generate: false }, cfBuildOutput: true } }
    }),
    tanstackStart(),
    react()
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url))
    }
  }
};
});
