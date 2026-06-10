/**
 * Provider-agnostic shapes. Every concrete provider adapter normalizes
 * to these so the agent runtime never branches on provider id.
 */

export const PROVIDER_IDS = [
    "openai",
    "anthropic",
    "google",
    "mistral",
    "groq",
    "azure",
    "copilot",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google Gemini",
    mistral: "Mistral",
    groq: "Groq",
    azure: "Azure AI Foundry",
    copilot: "GitHub Copilot",
};

export interface ModelCapabilities {
    chat: boolean;
    tools: boolean;
    vision: boolean;
    audioIn: boolean;
    audioOut: boolean;
    embeddings: boolean;
    /** Max input context window in tokens. */
    contextTokens: number;
    /** Max output tokens. */
    outputTokens: number;
    /** Optional cost hints (USD per million tokens) for the usage dashboard. */
    inputCostPerMTok?: number;
    outputCostPerMTok?: number;
}

export interface ModelInfo {
    provider: ProviderId;
    id: string;
    label: string;
    family?: string;
    capabilities: ModelCapabilities;
}

export interface ProviderConnection {
    id: string;
    userId: string;
    provider: ProviderId;
    label?: string;
    /** Decrypted at use-time; never stored on the wire. */
    secrets: ProviderSecrets;
    status: "active" | "expired" | "revoked";
    createdAt: Date;
    updatedAt: Date;
}

export type ProviderSecrets =
    | { kind: "apiKey"; apiKey: string }
    | {
          kind: "copilot";
          /** GitHub user OAuth access token (long-lived). */
          oauthToken: string;
          /** Short-lived Copilot session token (~25 min). */
          sessionToken?: string;
          sessionExpiresAt?: Date;
          endpoints?: { api: string; [k: string]: string };
      };

export interface ProviderAdapter {
    id: ProviderId;
    /** List models the connection has access to. */
    listModels(conn: ProviderConnection): Promise<ModelInfo[]>;
    /** Mint an `ai`-SDK LanguageModel for the given model id. */
    languageModel(conn: ProviderConnection, modelId: string): unknown;
    /** Refresh credentials if applicable. Returns updated secrets. */
    refresh?(conn: ProviderConnection): Promise<ProviderSecrets>;
}
