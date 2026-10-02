import { bindings, defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "kinic-skill-registry-web",
		compatibilityDate: "2026-07-15",
		compatibilityFlags: [
			"nodejs_compat",
			"global_fetch_strictly_public",
		],
		entrypoint: "@tanstack/react-start/server-entry",
		observability: {
			enabled: true,
		},
		env: {
			VITE_WIKI_IC_HOST: bindings.text("https://icp0.io"),
			VITE_KINIC_WIKI_CANISTER_ID: bindings.text("6emaw-iyaaa-aaaay-aacka-cai"),
		},
	},
});
