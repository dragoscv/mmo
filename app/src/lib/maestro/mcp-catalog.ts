/**
 * Static prompt + resource catalog exposed via the MCP façade.
 *
 * Prompts are reusable instruction templates a host (Claude Desktop,
 * Cursor) can drop into a conversation. Resources are read-only URIs
 * the host can fetch to ground the model with up-to-date project /
 * library state.
 *
 * Keep these pure metadata — the actual data fetching lives in
 * `resolveResource` which uses Maestro's existing tool catalog to keep
 * scope enforcement centralised.
 */

export interface McpPromptArg {
    name: string;
    description: string;
    required?: boolean;
}

export interface McpPrompt {
    name: string;
    description: string;
    arguments?: McpPromptArg[];
}

export interface McpResource {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
    /** Tool the resolver dispatches to. Must exist in `buildTools`. */
    tool: string;
    /** Static input passed to the tool. */
    input?: Record<string, unknown>;
}

export const MCP_PROMPTS: McpPrompt[] = [
    {
        name: "find-similar-tracks",
        description: "Given a track name or ID, find sonically similar tracks in the library.",
        arguments: [
            { name: "track", description: "Track ID or title to match against", required: true },
            { name: "limit", description: "How many candidates to return (default 10)" },
        ],
    },
    {
        name: "suggest-setlist",
        description: "Suggest an opening setlist that respects BPM/key transitions for a given genre.",
        arguments: [
            { name: "genre", description: "Target genre (e.g. tech-house, manele, balkanica)", required: true },
            { name: "lengthMinutes", description: "Total setlist length in minutes (default 60)" },
        ],
    },
    {
        name: "summarize-recent-generations",
        description: "Summarize the user's recent AI-generated assets with status + prompt.",
    },
];

export function renderPrompt(name: string, args: Record<string, unknown> | undefined): string {
    const a = args ?? {};
    switch (name) {
        case "find-similar-tracks":
            return `Find tracks similar to "${a.track ?? "<missing>"}". Limit ${a.limit ?? 10} results. Use listLibraryTracks + analysis metadata to compare BPM, key, and energy.`;
        case "suggest-setlist":
            return `Build a ${a.lengthMinutes ?? 60}-minute opening setlist for the genre "${a.genre ?? "<missing>"}". Use the library tools to fetch candidates; ensure BPM transitions are smooth (±6 BPM) and key changes follow the Camelot wheel.`;
        case "summarize-recent-generations":
            return `Call listRecentGenerations and produce a short bullet-list summary grouped by status (ready / pending / failed).`;
        default:
            return `Unknown prompt: ${name}`;
    }
}

export const MCP_RESOURCES: McpResource[] = [
    {
        uri: "mmo://library/recent-tracks",
        name: "Recent Library Tracks",
        description: "Most recently imported tracks in the library.",
        mimeType: "application/json",
        tool: "listLibraryTracks",
        input: { limit: 25 },
    },
    {
        uri: "mmo://daw/projects",
        name: "DAW Projects",
        description: "List of saved DAW projects with metadata.",
        mimeType: "application/json",
        tool: "listDawProjects",
    },
];
