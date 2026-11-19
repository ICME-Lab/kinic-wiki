// Test-only inspector; never emitted into production UI assets.
import { build } from "../../vaultbrowser/node_modules/vite/dist/node/index.js";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
await build({
  configFile: false,
  root,
  build: {
    outDir: "target/vault-browser-readback",
    lib: {
      entry: resolve(root, "vaultbrowser/fixtures/acceptance-readback.ts"),
      formats: ["es"],
      fileName: () => "readback.mjs",
    },
    rollupOptions: { output: { codeSplitting: false } },
  },
});
