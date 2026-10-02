import { bindings, defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "kinic-wiki-mcp",
		compatibilityDate: "2026-05-12",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		observability: {
			enabled: true,
		},
		domains: [
			"wiki-mcp.kinic.xyz",
		],
		env: {
			KINIC_WIKI_CANISTER_ID: bindings.text("6emaw-iyaaa-aaaay-aacka-cai"),
			KINIC_WIKI_IC_HOST: bindings.text("https://icp0.io"),
			KINIC_WIKI_PUBLIC_ORIGIN: bindings.text("https://wiki.kinic.xyz"),
			MCP_ACCESS_POLICY: bindings.text("public"),
			MCP_WRITE_POLICY: bindings.text("disabled"),
			OPENAI_APPS_CHALLENGE_TOKEN: bindings.text("U3C-sqKN0SbnEf0lSfTGWrkMABESA3cacw1i74cr8oU"),
		},
	},
});
