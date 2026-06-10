/**
 * Constants/types shared between AI-keys server actions and the client
 * UI. Lives outside `actions/ai-keys.ts` because Next 16's "use server"
 * files may only export async functions; non-function exports break the
 * build during page-data collection.
 */

export const SUPPORTED_PROVIDERS = ["azure", "openai", "anthropic", "google", "mistral", "groq"] as const;
export type AiProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** Default provider chosen when the user hasn't picked one yet. Azure
 *  AI Foundry is the recommended default — it has a generous free tier
 *  and works with both OpenAI and partner models behind a single key. */
export const DEFAULT_PROVIDER: AiProvider = "azure";

export interface AiKeyInfo {
    provider: AiProvider;
    isSet: boolean;
    masked: string;
    updatedAt: Date | null;
}

/** Display labels for the provider picker UI. */
export const PROVIDER_LABELS: Record<AiProvider, string> = {
    azure: "Azure AI Foundry (recommended)",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google Gemini",
    mistral: "Mistral",
    groq: "Groq",
};
