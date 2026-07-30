// Where: workers/wiki-mcp/src/tool-metadata.ts
// What: Shared names and safety annotations for the Wiki MCP read tools and private connection tool.
// Why: Discovery metadata and registered tool annotations must stay consistent.

export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
  destructiveHint: false
} as const;

export const MCP_TOOL_NAMES = [
  "find_databases",
  "search",
  "fetch_many",
  "read_path",
  "read_paths",
  "list",
  "memory_manifest",
  "context"
] as const;

export const CONNECT_PRIVATE_TOOL_NAME = "connect_private" as const;

export type ToolAccessPolicy = "public" | "private_required" | "private_opt_in";

const NO_AUTH_SECURITY_SCHEME = { type: "noauth" } as const;
const OAUTH_SECURITY_SCHEME = { type: "oauth2", scopes: ["mcp:read"] } as const;

export function toolAuthMetadata(
  accessPolicy: ToolAccessPolicy,
  requiresPrivateConnection = false
): { securitySchemes: Array<
  | typeof NO_AUTH_SECURITY_SCHEME
  | { type: "oauth2"; scopes: string[] }
> } {
  const oauth = { ...OAUTH_SECURITY_SCHEME, scopes: [...OAUTH_SECURITY_SCHEME.scopes] };
  if (requiresPrivateConnection || accessPolicy === "private_required") {
    return { securitySchemes: [oauth] };
  }
  if (accessPolicy === "private_opt_in") {
    return { securitySchemes: [NO_AUTH_SECURITY_SCHEME, oauth] };
  }
  return { securitySchemes: [NO_AUTH_SECURITY_SCHEME] };
}

export function mcpToolNames(privateConnectionAvailable: boolean): string[] {
  return privateConnectionAvailable
    ? [...MCP_TOOL_NAMES, CONNECT_PRIVATE_TOOL_NAME]
    : [...MCP_TOOL_NAMES];
}
