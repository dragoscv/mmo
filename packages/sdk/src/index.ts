/**
 * @mmo/sdk — thin REST + SSE client for MMO. Full implementation in P11.
 */

export interface MmoClientOptions {
    baseUrl: string;
    /** PAT minted at /settings/copilot → Developer → Tokens. */
    token: string;
    fetch?: typeof fetch;
}

export class MmoClient {
    constructor(readonly options: MmoClientOptions) {}

    // Surface implemented in P11.
    readonly agent = {
        run: async (_input: { projectId?: string; prompt: string }): Promise<unknown> => {
            throw new Error("@mmo/sdk: agent.run() lands in P11");
        },
    };
}
