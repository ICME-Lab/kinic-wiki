import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare({
    persistState: { path: ".wrangler/state" },
    experimental: { newConfig: { types: { generate: false }, cfBuildOutput: true } }
  })]
});
