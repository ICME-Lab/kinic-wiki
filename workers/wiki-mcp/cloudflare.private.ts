// Retired classes mirror the preserved original history in wrangler.*.jsonc.
import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
	worker: {
		name: "kinic-wiki-mcp-private",
		compatibilityDate: "2026-05-12",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		workersDev: false,
		observability: {
			enabled: true,
		},
		domains: [
			"wiki-private-mcp.kinic.xyz",
		],
		exports: {
			McpAuthStateV5: exports.durableObject({ storage: "sqlite" }),
			McpAuthStateV4: exports.durableObject({ state: "deleted" }),
		},
		env: {
			KINIC_WIKI_CANISTER_ID: bindings.text("6emaw-iyaaa-aaaay-aacka-cai"),
			KINIC_WIKI_IC_HOST: bindings.text("https://icp0.io"),
			KINIC_WIKI_MCP_TARGET_ORIGIN: bindings.text("https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app"),
			KINIC_WIKI_PUBLIC_ORIGIN: bindings.text("https://wiki.kinic.xyz"),
			MCP_ACCESS_POLICY: bindings.text("private_required"),
			MCP_WRITE_POLICY: bindings.text("private"),
			MCP_PUBLIC_ORIGIN: bindings.text("https://wiki-private-mcp.kinic.xyz"),
			MCP_REVIEW_LOGIN_ENABLED: bindings.text("true"),
			MCP_REVIEW_ACCESS_VERSION: bindings.text("review-v1"),
			MCP_REVIEW_WRITE_PREFIX: bindings.text("/OpenAIReview/scratch"),
			OPENAI_APPS_CHALLENGE_TOKEN: bindings.text("eegi6ZKN5pqSVhGk_gLEED4Xa7R5gwHfYc5ej5v8Mj0"),
			MCP_AUTH_STATE: bindings.durableObject({
				worker: "kinic-wiki-mcp-private",
				exportName: "McpAuthStateV5",
			}),
			MCP_REGISTRATION_RATE_LIMIT: bindings.rateLimit({
				namespace: "7802027",
				simple: {
					limit: 10,
					period: 60,
				},
			}),
			MCP_REVIEW_LOGIN_RATE_LIMIT: bindings.rateLimit({
				namespace: "7802029",
				simple: {
					limit: 10,
					period: 60,
				},
			}),
		},
		},
});
