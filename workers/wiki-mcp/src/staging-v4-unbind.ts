// Where: workers/wiki-mcp/src/staging-v4-unbind.ts
// What: Transitional entrypoint for removing the live V3 Durable Object binding.
// Why: Cloudflare requires the bound V3 export to remain present in the version that removes its binding.

export { default } from "./index.js";
export { McpAuthStateV4 as McpAuthStateV3 } from "./auth/state.js";
