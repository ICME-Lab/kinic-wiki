/* eslint-disable */
// Generated from cloudflare.config.ts by pnpm cf-typegen.
declare namespace Cloudflare {
	interface Env {
		"ASSISTANT_DB": D1Database;
		"ASSISTANT_DERIVATION_ORIGIN": string;
		"ASSISTANT_ENABLED": string;
		"ASSISTANT_ORIGIN": string;
		"AUTH_RATE_LIMIT": RateLimit;
		"KINIC_WIKI_CANISTER_ID": string;
	}
}
interface Env extends Cloudflare.Env {}
interface AssistantEnv extends Cloudflare.Env {}
