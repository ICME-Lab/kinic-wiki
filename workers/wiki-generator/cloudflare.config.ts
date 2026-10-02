// D1 SQL migrations are applied separately with cf d1 migrations --dir migrations.
import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig((ctx) => {
	switch (ctx.mode) {
		case "staging": {
			return defineConfig({
				accountId: "9029b5f9de5b2e820eaf4ed562bcb0e7",
				worker: {
					name: "kinic-wiki-generator-staging",
					compatibilityDate: "2026-05-12",
					compatibilityFlags: [
						"nodejs_compat",
					],
					entrypoint: "src/index.ts",
					workersDev: true,
					observability: {
						enabled: true,
					},
					triggers: [
						triggers.queue({
							maxBatchSize: 4,
							maxBatchTimeout: 1,
							maxConcurrency: 5,
							maxRetries: 5,
							name: "kinic-wiki-generation-staging",
						}),
					],
					env: {
						KINIC_WIKI_CANISTER_ID: bindings.text("3ryrw-kyaaa-aaaaf-qgxpq-cai"),
						KINIC_WIKI_IC_HOST: bindings.text("https://icp0.io"),
						KINIC_WIKI_ALLOWED_DATABASE_ID: bindings.text("db_nuzrspghca5q"),
						KINIC_WIKI_WORKER_MODEL: bindings.text("deepseek-v4-flash"),
						KINIC_WIKI_WORKER_TARGET_ROOT: bindings.text("/Knowledge/conversations"),
						KINIC_WIKI_WORKER_SOURCE_PREFIX: bindings.text("/Sources"),
						KINIC_WIKI_WORKER_CONTEXT_PREFIX: bindings.text("/"),
						KINIC_WIKI_WORKER_CONTEXT_CANDIDATES: bindings.text("20"),
						KINIC_WIKI_WORKER_CONTEXT_SELECTIONS: bindings.text("5"),
						DB: bindings.d1({
							name: "kinic-wiki-generator-staging",
							id: "0fb15a11-05da-4afd-b306-e3b5b0af582a",
						}),
						LINK_PREVIEW_IMAGES: bindings.r2({
							name: "kinic-wiki-link-preview-images-staging",
						}),
						WIKI_GENERATION_QUEUE: bindings.queue({
							name: "kinic-wiki-generation-staging",
						}),
						WIKI_GENERATION_DLQ: bindings.queue({
							name: "kinic-wiki-generation-failures-staging",
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
					name: "kinic-wiki-generator",
					compatibilityDate: "2026-05-12",
					compatibilityFlags: [
						"nodejs_compat",
					],
					entrypoint: "src/index.ts",
					observability: {
						enabled: true,
					},
					domains: [
						"wiki-generator.kinic.xyz",
					],
					triggers: [
						triggers.queue({
							maxBatchSize: 4,
							maxBatchTimeout: 1,
							maxConcurrency: 5,
							maxRetries: 5,
							name: "kinic-wiki-generation",
						}),
					],
					env: {
						KINIC_WIKI_CANISTER_ID: bindings.text("6emaw-iyaaa-aaaay-aacka-cai"),
						KINIC_WIKI_IC_HOST: bindings.text("https://icp0.io"),
						KINIC_WIKI_WORKER_MODEL: bindings.text("deepseek-v4-flash"),
						KINIC_WIKI_WORKER_TARGET_ROOT: bindings.text("/Knowledge/conversations"),
						KINIC_WIKI_WORKER_SOURCE_PREFIX: bindings.text("/Sources"),
						KINIC_WIKI_WORKER_CONTEXT_PREFIX: bindings.text("/"),
						KINIC_WIKI_WORKER_CONTEXT_CANDIDATES: bindings.text("20"),
						KINIC_WIKI_WORKER_CONTEXT_SELECTIONS: bindings.text("5"),
						DB: bindings.d1({
							name: "kinic-wiki-generator",
							id: "c82cdeed-424c-474a-8552-23b2b7e74a7a",
						}),
						LINK_PREVIEW_IMAGES: bindings.r2({
							name: "kinic-wiki-link-preview-images",
						}),
						WIKI_GENERATION_QUEUE: bindings.queue({
							name: "kinic-wiki-generation",
						}),
						WIKI_GENERATION_DLQ: bindings.queue({
							name: "kinic-wiki-generation-failures",
						}),
					},
					},
			});
		}
		default: throw new Error(`Unsupported Cloudflare mode: ${ctx.mode}`);
	}
});
