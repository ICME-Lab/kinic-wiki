import type { McpAuthStateV4 } from "../src/auth/state.js";

declare global {
  namespace Cloudflare {
    interface Env {
      MCP_AUTH_STATE: DurableObjectNamespace<McpAuthStateV4>;
      MCP_REGISTRATION_RATE_LIMIT: RateLimit;
      MCP_KEY_ENCRYPTION_KEY: string;
      MCP_ACCESS_POLICY: string;
      MCP_WRITE_POLICY: string;
      MCP_PUBLIC_ORIGIN: string;
      KINIC_WIKI_MCP_TARGET_ORIGIN: string;
    }
  }
}
