// D1 SQL migrations are applied separately with cf d1 migrations --dir migrations.
import { bindings, defineConfig, exports, triggers } from "cf/config";

export default defineConfig((ctx) => {
	switch (ctx.mode) {
		case "staging": {
			return defineConfig({
				worker: {
					name: "kinic-wiki-assistant-staging",
					compatibilityDate: "2026-08-08",
					compatibilityFlags: [
						"nodejs_compat",
					],
					entrypoint: "src/index.ts",
					exports: { AssistantConnection: exports.durableObject({ storage: "sqlite" }) },
					workersDev: false,
					observability: {
						enabled: true,
					},
					triggers: [
						triggers.scheduled({
							schedule: "* * * * *",
						}),
					],
					env: {
						ASSISTANT_CONNECTION: bindings.durableObject({ worker: "kinic-wiki-assistant-staging", exportName: "AssistantConnection" }),
						ASSISTANT_ENABLED: bindings.text("true"),
						KINIC_WIKI_CANISTER_ID: bindings.text("3ryrw-kyaaa-aaaaf-qgxpq-cai"),
						ASSISTANT_ORIGIN: bindings.text("https://kinic-wiki-browser-staging.hude.workers.dev"),
						ASSISTANT_DERIVATION_ORIGIN: bindings.text("https://3ryrw-kyaaa-aaaaf-qgxpq-cai.icp0.io"),
						ASSISTANT_DB: bindings.d1({
							name: "kinic-wiki-assistant-staging",
							id: "81d9a64a-6f68-4cb5-a91d-5513fa9cf57d",
						}),
						AUTH_RATE_LIMIT: {
							type: "unsafe:ratelimit",
							namespace_id: "4102",
							simple: {
								limit: 10,
								period: 60,
							},
						},
					},
					},
			});
		}
		case undefined:
		case "production": {
			return defineConfig({
				worker: {
					name: "kinic-wiki-assistant",
					compatibilityDate: "2026-08-08",
					compatibilityFlags: [
						"nodejs_compat",
					],
					entrypoint: "src/index.ts",
					exports: { AssistantConnection: exports.durableObject({ storage: "sqlite" }) },
					workersDev: false,
					observability: {
						enabled: true,
					},
					triggers: [
						triggers.scheduled({
							schedule: "* * * * *",
						}),
					],
					env: {
						ASSISTANT_CONNECTION: bindings.durableObject({ worker: "kinic-wiki-assistant", exportName: "AssistantConnection" }),
						ASSISTANT_ENABLED: bindings.text("true"),
						KINIC_WIKI_CANISTER_ID: bindings.text("6emaw-iyaaa-aaaay-aacka-cai"),
						ASSISTANT_ORIGIN: bindings.text("https://wiki.kinic.xyz"),
						ASSISTANT_DERIVATION_ORIGIN: bindings.text("https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io"),
						ASSISTANT_DB: bindings.d1({
							name: "kinic-wiki-assistant",
							id: "51dcc15a-a8f9-4d00-93d9-5ad8e0684584",
						}),
						AUTH_RATE_LIMIT: {
							type: "unsafe:ratelimit",
							namespace_id: "4101",
							simple: {
								limit: 10,
								period: 60,
							},
						},
					},
					},
			});
		}
		default: throw new Error(`Unsupported Cloudflare mode: ${ctx.mode}`);
	}
});
