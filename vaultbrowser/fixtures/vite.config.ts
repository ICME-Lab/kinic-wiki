import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../public", import.meta.url)),
  plugins: [
    react(),
    {
      name: "synthetic-funding-config",
      configureServer(server) {
        server.middlewares.use("/config.json", (request, response) => {
          const origin = `http://${request.headers.host}`;
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
              host: origin,
              derivationOrigin:
                "http://rrkah-fqaaa-aaaaa-aaaaq-cai.localhost:3023",
              identityProvider:
                "http://rdmx6-jaaaa-aaaaa-aaadq-cai.localhost:3023",
              origin,
              local: true,
              fundingMode: request.url?.includes("fixture=funding")
                ? "synthetic-test-only"
                : "unavailable",
            }),
          );
        });
      },
    },
  ],

  css: { postcss: fileURLToPath(new URL("..", import.meta.url)) },
  server: {
    host: "127.0.0.1",
    port: 3023,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] },
  },
});
