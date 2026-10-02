// Retired classes mirror the preserved v1–v5 history in wrangler.*.jsonc.
import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
	worker: {
		name: "kinic-wiki-mcp-staging",
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
			"wiki-mcp-staging.kinic.xyz",
		],
		exports: {
			McpAuthStateV5: exports.durableObject({ storage: "sqlite" }),
			McpAuthState: exports.durableObject({ state: "deleted" }),
			McpAuthStateV2: exports.durableObject({ state: "deleted" }),
			McpAuthStateV3: exports.durableObject({ state: "deleted" }),
			McpAuthStateV4: exports.durableObject({ state: "deleted" }),
		},
		env: {
			KINIC_WIKI_CANISTER_ID: bindings.text("3ryrw-kyaaa-aaaaf-qgxpq-cai"),
			KINIC_WIKI_IC_HOST: bindings.text("https://icp0.io"),
			KINIC_WIKI_MCP_TARGET_ORIGIN: bindings.text("https://3ryrw-kyaaa-aaaaf-qgxpq-cai.ic0.app"),
			KINIC_WIKI_PUBLIC_ORIGIN: bindings.text("https://kinic-wiki-browser-staging.hude.workers.dev"),
			MCP_ACCESS_POLICY: bindings.text("private_required"),
			MCP_WRITE_POLICY: bindings.text("private"),
			MCP_PUBLIC_ORIGIN: bindings.text("https://wiki-mcp-staging.kinic.xyz"),
			MCP_REVIEW_LOGIN_ENABLED: bindings.text("true"),
			MCP_REVIEW_ACCESS_VERSION: bindings.text("review-v1"),
			MCP_REVIEW_WRITE_PREFIX: bindings.text("/OpenAIReview/scratch"),
			OPENAI_APPS_CHALLENGE_TOKEN: bindings.text("U3C-sqKN0SbnEf0lSfTGWrkMABESA3cacw1i74cr8oU"),
			MCP_AUTH_STATE: bindings.durableObject({
				worker: "kinic-wiki-mcp-staging",
				exportName: "McpAuthStateV5",
			}),
			MCP_REGISTRATION_RATE_LIMIT: bindings.rateLimit({
				namespace: "7802026",
				simple: {
					limit: 10,
					period: 60,
				},
			}),
			MCP_REVIEW_LOGIN_RATE_LIMIT: bindings.rateLimit({
				namespace: "7802028",
				simple: {
					limit: 10,
					period: 60,
				},
			}),
		},
		},
});
