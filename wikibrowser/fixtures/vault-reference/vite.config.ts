import { join, normalize } from "node:path";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const fixture = fileURLToPath(new URL(".", import.meta.url));
const wiki = fileURLToPath(new URL("../..", import.meta.url));
const workspace = fileURLToPath(new URL("../../..", import.meta.url));
const port = 3016;
const wikiOrigin = `http://127.0.0.1:${port}`;
const syntheticVault = `http://vault.localhost:${port}`;

export default defineConfig({
  root: fixture,
  css: { postcss: wiki },
  plugins: [
    {
      name: "fixture-article-write",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer?.endsWith("/components/markdown-edit-document.tsx") &&
            (source === "@/lib/vfs-client" || normalize(source) === join(wiki, "lib/vfs-client"))) {
          return fileURLToPath(new URL("./article.ts", import.meta.url));
        }
      }
    },
    react(),
    {
      name: "synthetic-vault-reference",
      configureServer(server) {
        if (process.env.VITE_LOCAL_VAULT_ORIGIN) return;
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? "/", wikiOrigin);
          const isVault = request.headers.host === new URL(syntheticVault).host;
          const picker = isVault && url.pathname === "/pick";
          const embed = isVault && url.pathname.startsWith("/embed/");
          const spoof = url.pathname === "/spoof";
          if (!picker && !embed && !spoof) return next();

          response.setHeader("Content-Type", "text/html; charset=utf-8");
          if (embed) {
            response.setHeader("Content-Security-Policy", `frame-ancestors ${wikiOrigin}`);
            response.end("<!doctype html><title>Fixture Vault document</title><p>Synthetic document inside Vault.</p>");
            return;
          }

          response.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
          response.end(`<!doctype html>
            <title>Synthetic Vault picker</title>
            <button disabled>Select fixture document</button>
            <p role="status">${spoof ? "Spoofed selection sent" : "Waiting for Wiki"}</p>
            <script>
              const wiki = ${JSON.stringify(wikiOrigin)};
              const selection = {
                type: "kinic-vault-selection",
                vault: "0123456789abcdef0123456789abcdef",
                object: "fedcba9876543210fedcba9876543210"
              };
              if (${spoof}) {
                opener.postMessage(selection, wiki);
              } else {
                const button = document.querySelector("button");
                addEventListener("message", (event) => {
                  if (event.origin !== wiki || event.source !== opener || event.data?.type !== "kinic-vault-picker-connect") return;
                  button.disabled = false;
                  document.querySelector("[role=status]").textContent = "Connected to Wiki";
                });
                button.onclick = () => {
                  opener.postMessage(selection, wiki);
                  close();
                };
                opener.postMessage({ type: "kinic-vault-picker-ready" }, wiki);
              }
            </script>`);
        });
      }
    }
  ],
  define: {
    "import.meta.env.VITE_LOCAL_VAULT_ORIGIN": JSON.stringify(process.env.VITE_LOCAL_VAULT_ORIGIN ?? syntheticVault)
  },
  resolve: { alias: { "@": wiki } },
  server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [workspace] } }
});
