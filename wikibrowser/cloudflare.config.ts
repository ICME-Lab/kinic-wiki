import { bindings, defineConfig } from "cf/config";

export default defineConfig((ctx) => {
	switch (ctx.mode) {
		case "staging": {
			return defineConfig({
				accountId: "9029b5f9de5b2e820eaf4ed562bcb0e7",
				worker: {
					name: "kinic-wiki-browser-staging",
					compatibilityDate: "2026-07-15",
					compatibilityFlags: [
						"nodejs_compat",
						"global_fetch_strictly_public",
					],
					entrypoint: "src/server.ts",
					workersDev: true,
					observability: {
						enabled: true,
					},
					env: {
                        KINIC_WIKI_WORKER_TOKEN: bindings.secret(),
						KINIC_DEPLOYMENT_ENV: bindings.text("staging"),
						VITE_WIKI_IC_HOST: bindings.text("https://icp0.io"),
						VITE_KINIC_WIKI_CANISTER_ID: bindings.text("3ryrw-kyaaa-aaaaf-qgxpq-cai"),
						KINIC_WIKI_CANISTER_ID: bindings.text("3ryrw-kyaaa-aaaaf-qgxpq-cai"),
						VITE_II_DERIVATION_ORIGIN: bindings.text("https://3ryrw-kyaaa-aaaaf-qgxpq-cai.icp0.io"),
						KINIC_WIKI_GENERATOR_URL: bindings.text("https://kinic-wiki-generator-staging.hude.workers.dev"),
						KINIC_WIKI_ALLOWED_DATABASE_ID: bindings.text("db_nuzrspghca5q"),
						RECALL_ALLOWED_DATABASE_ID: bindings.text("db_moj6zr34uvmf"),
						RECALL_JEV_THRESHOLD: bindings.text("0.39"),
						KINIC_WIKI_CLIPPER_ORIGIN: bindings.text("chrome-extension://kdildjebipiaccglghfdhjifgknlpffg"),
						QUERY_ANSWER_RATE_LIMIT: bindings.kv({
							id: "dd821e7a3e4f4f908df20c2cb17abc2d",
						}),
						LINK_PREVIEW_IMAGES: bindings.r2({
							name: "kinic-wiki-link-preview-images-staging",
						}),
						LINK_PREVIEW_QUEUE: bindings.queue({
							name: "kinic-wiki-generation-staging",
						}),
						WIKI_ASSISTANT: bindings.worker({
							worker: "kinic-wiki-assistant-staging",
						}),
					},
				},
			});
		}
		case undefined:
		case "development":
		case "production": {
			return defineConfig({
				accountId: "9029b5f9de5b2e820eaf4ed562bcb0e7",
				worker: {
					name: "kinic-wiki-browser",
					compatibilityDate: "2026-07-15",
					compatibilityFlags: [
						"nodejs_compat",
						"global_fetch_strictly_public",
					],
					entrypoint: "src/server.ts",
					observability: {
						enabled: true,
						issues: { enabled: true },
					},
					domains: [
						"kinic.xyz",
						"wiki.kinic.xyz",
					],
					env: {
                        DEEPSEEK_API_KEY: bindings.secret(),
                        TYPESAFE_API_KEY: bindings.secret(),
                        KINIC_WIKI_WORKER_TOKEN: bindings.secret(),
						VITE_WIKI_IC_HOST: bindings.text("https://icp0.io"),
						VITE_KINIC_WIKI_CANISTER_ID: bindings.text("6emaw-iyaaa-aaaay-aacka-cai"),
						KINIC_WIKI_CANISTER_ID: bindings.text("6emaw-iyaaa-aaaay-aacka-cai"),
						KINIC_WIKI_GENERATOR_URL: bindings.text("https://wiki-generator.kinic.xyz"),
						RECALL_JEV_THRESHOLD: bindings.text("0.39"),
						QUERY_ANSWER_RATE_LIMIT: bindings.kv({
							id: "72995eb374a14e71b1a35a545beca160",
						}),
						LINK_PREVIEW_IMAGES: bindings.r2({
							name: "kinic-wiki-link-preview-images",
						}),
						LINK_PREVIEW_QUEUE: bindings.queue({
							name: "kinic-wiki-generation",
						}),
						WIKI_ASSISTANT: bindings.worker({
							worker: "kinic-wiki-assistant",
						}),
					},
				},
			});
		}
		default: throw new Error(`Unsupported Cloudflare mode: ${ctx.mode}`);
	}
});
