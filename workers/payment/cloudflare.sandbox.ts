// D1 SQL migrations are applied separately with cf d1 migrations --dir migrations.
import { bindings, defineConfig } from "cf/config";

export default defineConfig({
	accountId: "9029b5f9de5b2e820eaf4ed562bcb0e7",
	worker: {
		name: "kinic-payment-sandbox",
		compatibilityDate: "2026-07-09",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/worker.ts",
		workersDev: true,
		observability: {
			enabled: true,
		},
		env: {
			KINIC_WIKI_CANISTER_ID: bindings.text("3ryrw-kyaaa-aaaaf-qgxpq-cai"),
			KINIC_WIKI_IC_HOST: bindings.text("https://icp0.io"),
			KINIC_IAP_AUTHORITY_ID: bindings.text("jao7b-vs75q-xlvit-szusc-eiiv3-sel57-6iyuu-6fzkh-lqui4-mbqcf-aae"),
			APP_STORE_ALLOWED_ENVIRONMENTS: bindings.text("Sandbox"),
			APP_STORE_SANDBOX_FULFILLMENT_ENABLED: bindings.text("true"),
			APP_STORE_SANDBOX_GRANT_LIMIT: bindings.text("1000"),
			APP_STORE_BUNDLE_ID: bindings.text("xyz.kinic.ios.KinicWiki"),
			APP_STORE_NOTIFICATION_ROOT_SHA256S: bindings.text("B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24,C2:B9:B0:42:DD:57:83:0E:7D:11:7D:AC:55:AC:8A:E1:94:07:D3:8E:41:D8:8F:32:15:BC:3A:89:04:44:A0:50,63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79"),
			IAP_PRODUCT_CATALOG_JSON: bindings.text("{\"xyz.kinic.dbcredits.small\":\"2000000000000\"}"),
			DB: bindings.d1({
				name: "kinic-payment-sandbox",
				id: "d93a00ac-27be-485e-8c4b-1065c1f29bd2",
				dev: {
					remote: true,
				},
			}),
			IAP_GLOBAL_RATE_LIMITER: bindings.rateLimit({
				namespace: "21001",
				simple: {
					limit: 300,
					period: 60,
				},
			}),
			IAP_PRINCIPAL_RATE_LIMITER: bindings.rateLimit({
				namespace: "21002",
				simple: {
					limit: 10,
					period: 60,
				},
			}),
		},
		},
});
