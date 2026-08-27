import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { createHash } from "node:crypto";
import { defineConfig } from "vitest/config";

const reviewIdentity = Ed25519KeyIdentity.generate();
const credentialHash = (value: string) => createHash("sha256").update(value).digest("base64url");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./tests/auth-worker-entry.ts",
      wrangler: { configPath: "./wrangler.staging.jsonc" },
      miniflare: {
        bindings: {
          MCP_KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          MCP_REVIEW_LOGIN_ENABLED: "true",
          MCP_REVIEW_USERNAME_HASH: credentialHash("openai-review"),
          MCP_REVIEW_PASSWORD_HASH: credentialHash("review-password"),
          MCP_REVIEW_IDENTITY_KEY: JSON.stringify(reviewIdentity.toJSON()),
          MCP_REVIEW_IDENTITY_PRINCIPAL: reviewIdentity.getPrincipal().toText(),
          MCP_REVIEW_ACCESS_VERSION: "review-v1",
          MCP_REVIEW_DATABASE_ID: "db_abcdefghijkl",
          MCP_REVIEW_WRITE_PREFIX: "/OpenAIReview/scratch"
        }
      }
    })
  ],
  test: {
    include: ["tests/auth.worker.test.ts"]
  }
});
