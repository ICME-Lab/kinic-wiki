import type { McpAuthStateV5 } from "../src/auth/state.js";

declare global {
  namespace Cloudflare {
    interface Env {
      MCP_AUTH_STATE: DurableObjectNamespace<McpAuthStateV5>;
      MCP_REGISTRATION_RATE_LIMIT: RateLimit;
      MCP_REVIEW_LOGIN_RATE_LIMIT: RateLimit;
      MCP_REVIEW_LOGIN_ENABLED: string;
      MCP_REVIEW_USERNAME_HASH: string;
      MCP_REVIEW_PASSWORD_HASH: string;
      MCP_REVIEW_IDENTITY_KEY: string;
      MCP_REVIEW_IDENTITY_PRINCIPAL: string;
      MCP_REVIEW_ACCESS_VERSION: string;
      MCP_KEY_ENCRYPTION_KEY: string;
      MCP_ACCESS_POLICY: string;
      MCP_WRITE_POLICY: string;
      MCP_PUBLIC_ORIGIN: string;
      KINIC_WIKI_MCP_TARGET_ORIGIN: string;
    }
  }
}
