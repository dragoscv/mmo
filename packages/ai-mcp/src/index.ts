/**
 * MMO MCP server entry point. Implementations land in P11.
 */

export const MCP_SERVER_VERSION = "0.0.1";

export const MCP_SCOPES = [
    "daw:read",
    "daw:write",
    "generate:audio",
    "generate:midi",
    "library:read",
    "library:write",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

export interface McpAuthContext {
    userId: string;
    tokenId: string;
    scopes: McpScope[];
}
