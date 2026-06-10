export * from "./types";
export * from "./copilot";

import type { ProviderAdapter, ProviderId } from "./types";
import { copilotAdapter } from "./copilot";

/**
 * Registry mapping provider id → adapter. The non-copilot adapters
 * (openai, anthropic, google, mistral, groq, azure) land in P1 once
 * the AI-SDK v5 deps are added to the consuming app — they will
 * delegate to @ai-sdk/openai, @ai-sdk/anthropic, etc.
 */
export class ProviderRegistry {
    private adapters = new Map<ProviderId, ProviderAdapter>();

    register(adapter: ProviderAdapter): void {
        this.adapters.set(adapter.id, adapter);
    }

    get(id: ProviderId): ProviderAdapter | undefined {
        return this.adapters.get(id);
    }

    list(): ProviderAdapter[] {
        return Array.from(this.adapters.values());
    }
}

/** Default registry pre-populated with copilot. Other adapters added in P1. */
export const defaultProviderRegistry = (() => {
    const r = new ProviderRegistry();
    r.register(copilotAdapter);
    return r;
})();
