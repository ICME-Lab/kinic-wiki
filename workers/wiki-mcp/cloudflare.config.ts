import { defineConfig } from "cf/config";
import publicConfig from "./cloudflare.public.ts";
import privateConfig from "./cloudflare.private.ts";
import stagingConfig from "./cloudflare.staging.ts";
import privateUnbindConfig from "./cloudflare.private-v5-unbind.ts";
import stagingUnbindConfig from "./cloudflare.staging-v5-unbind.ts";

export default defineConfig((ctx) => {
  switch (ctx.mode) {
    case undefined:
    case "public": return publicConfig;
    case "private": return privateConfig;
    case "staging": return stagingConfig;
    case "private-v5-unbind": return privateUnbindConfig;
    case "staging-v5-unbind": return stagingUnbindConfig;
    default: throw new Error(`Unsupported Cloudflare mode: ${ctx.mode}`);
  }
});
