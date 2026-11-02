import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { harfbuzzWorkers } from "./harfbuzz-workers-plugin";

export default defineConfig({
  plugins: [harfbuzzWorkers(), cloudflare({
    persistState: { path: ".wrangler/state" },
    experimental: { newConfig: { types: { generate: false }, cfBuildOutput: true } }
  })]
});
