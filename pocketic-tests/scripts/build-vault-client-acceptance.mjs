// Bundle the actual current client and crypto unchanged for Node/PocketIC.
import { build } from "../../vaultbrowser/node_modules/vite/dist/node/index.js";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
await build({
  configFile: false,
  root,
  build: {
    outDir: "target/vault-ii-acceptance/client",
    lib: {
      entry: resolve(root, "pocketic-tests/fixtures/vault-client-entry.ts"),
      formats: ["es"],
      fileName: () => "client.mjs",
    },
    rollupOptions: { output: { codeSplitting: false } },
  },
});
