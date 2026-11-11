import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("../..", import.meta.url)) } },
  css: { postcss: fileURLToPath(new URL("../..", import.meta.url)) },
  server: {
    host: "127.0.0.1",
    port: 3023,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] },
  },
});
