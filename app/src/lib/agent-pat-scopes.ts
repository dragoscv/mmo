/** PAT scopes — pure constants imported by both server actions and UI. */

export const PAT_SCOPES = [
    "agent:read",
    "agent:run",
    "library:read",
    "library:write",
    "daw:read",
    "daw:write",
    "generate:audio",
    "training:read",
    "training:write",
    "feedback:write",
] as const;

export type PatScope = (typeof PAT_SCOPES)[number];
