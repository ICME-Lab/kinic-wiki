import { defineConfig, loadEnv } from "vite";
import { assertCreditBridgeBuild } from "@kinic/credit-bridge-candid/build-guard";
import react from "@vitejs/plugin-react";
export default defineConfig(({ command, mode }) => {
  assertCreditBridgeBuild(command, mode, { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env });
  return {
  plugins: [react()],
  build: {
    sourcemap: false
  },
  server: {
    host: "vault.localhost",
    port: 3024
  }
};
});
