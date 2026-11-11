// Vite transpiles the actual current client for Node-based real-Wasm protocol tests.
// No mocks or runtime changes; output stays in an ignored directory with SDK deps.
import { build } from "../../vaultbrowser/node_modules/vite/dist/node/index.js";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
await build({
  configFile: false,
  root: resolve(root, "packages/vault-crypto"),
  build: {
    outDir: ".tmp-test",
    lib: {
      entry: resolve(root, "packages/vault-client/src/incident.ts"),
      formats: ["es"],
      fileName: () => "incident.mjs",
    },
    rollupOptions: { external: [/^@icp-sdk\//] },
  },
});
// A separate test entry can read authoritative state under the actual browser II
// delegation. The acceptance runner serves it only through its owned Playwright
// route; it is never included in production assets or deployed canister sources.
await build({
  configFile: false,
  root: resolve(root, "vaultbrowser"),
  build: {
    outDir: resolve(root, "target/vault-browser-readback"),
    lib: {
      entry: resolve(root, "vaultbrowser/fixtures/acceptance-readback.ts"),
      formats: ["es"],
      fileName: () => "readback.mjs",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
