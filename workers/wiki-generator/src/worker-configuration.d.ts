/* eslint-disable */
// Generated from cloudflare.config.ts by pnpm cf-typegen.
declare namespace Cloudflare {
	interface Env {
		"DB": D1Database;
		"KINIC_WIKI_ALLOWED_DATABASE_ID"?: string;
		"KINIC_WIKI_CANISTER_ID": string;
		"KINIC_WIKI_IC_HOST": string;
		"KINIC_WIKI_WORKER_CONTEXT_CANDIDATES": string;
		"KINIC_WIKI_WORKER_CONTEXT_PREFIX": string;
		"KINIC_WIKI_WORKER_CONTEXT_SELECTIONS": string;
		"KINIC_WIKI_WORKER_MODEL": string;
		"KINIC_WIKI_WORKER_SOURCE_PREFIX": string;
		"KINIC_WIKI_WORKER_TARGET_ROOT": string;
		"LINK_PREVIEW_IMAGES": R2Bucket;
		"WIKI_GENERATION_DLQ": Queue;
		"WIKI_GENERATION_QUEUE": Queue;
	}
}
interface Env extends Cloudflare.Env {}
