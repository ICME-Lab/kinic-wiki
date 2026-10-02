import { defineConfig } from "cf/config";
import devConfig from "./cloudflare.dev.ts";
import sandboxConfig from "./cloudflare.sandbox.ts";

export default defineConfig(async (ctx) => {
  switch (ctx.mode) {
    case undefined:
    case "dev": return devConfig;
    case "sandbox": return sandboxConfig;
    case "production": {
      const path = "./cloudflare.production.ts";
      return (await import(path)).default as typeof devConfig;
    }
    default: throw new Error(`Unsupported Cloudflare mode: ${ctx.mode}`);
  }
});
