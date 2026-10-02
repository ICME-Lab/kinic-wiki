import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1", port: 3000 },
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
});
