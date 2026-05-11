/**
 * Constants/types shared between AI-keys server actions and the client
 * UI. Lives outside `actions/ai-keys.ts` because Next 16's "use server"
 * files may only export async functions; non-function exports break the
 * build during page-data collection.
 */

export const SUPPORTED_PROVIDERS = ["openai", "anthropic", "google", "mistral", "groq"] as const;
export type AiProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface AiKeyInfo {
    provider: AiProvider;
    isSet: boolean;
    masked: string;
    updatedAt: Date | null;
}
