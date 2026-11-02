// Where: workers/wiki-generator/harfbuzz-workers-plugin.ts
// What: Vite plugin that makes the harfbuzzjs package loadable in a Worker bundle.
// Why: The production build and the workerd tests must share this setup. Bundled hb.js sees neither __filename nor __dirname and crashes while looking for hb.wasm, which it never loads because src/harfbuzz-workers.ts supplies the module.
import { resolve } from "node:path";
import type { Plugin } from "vite";

export function harfbuzzWorkers(): Plugin {
  return {
    name: "kinic:harfbuzz-workers",
    enforce: "pre",
    config: () => ({
      resolve: {
        alias: [{ find: /^harfbuzzjs$/, replacement: resolve(import.meta.dirname, "src/harfbuzz-workers.ts") }]
      }
    }),
    transform(code, id) {
      if (!id.endsWith("/harfbuzzjs/hb.js")) return null;
      return { code: `var __filename = "hb.js", __dirname = ".";\n${code}`, map: null };
    }
  };
}
