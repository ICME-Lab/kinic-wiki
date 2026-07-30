import type { McpAuthState } from "../src/auth/state.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    MCP_AUTH_STATE: DurableObjectNamespace<McpAuthState>;
    MCP_KEY_ENCRYPTION_KEY: string;
    MCP_ACCESS_POLICY: string;
    MCP_PUBLIC_ORIGIN: string;
    KINIC_WIKI_MCP_TARGET_ORIGIN: string;
  }
}
