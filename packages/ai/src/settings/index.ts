/**
 * Per-user AI settings shape. Source of truth lives in the DB
 * (ai_provider_connection + ai_model_choice tables). This module
 * defines the in-memory representation passed around the app.
 */

import type { ModelChoices } from "../models";
import type { ProviderConnection } from "../providers/types";

export interface UserAISettings {
    connections: ProviderConnection[];
    choices: ModelChoices;
    agent: {
        autonomy: "ask" | "propose" | "auto";
        maxSteps: number;
        tokenBudget: number;
        allowDestructive: boolean;
        voiceInput: boolean;
        voiceOutput: boolean;
    };
    generation: {
        defaultTempo?: number;
        defaultKey?: string;
        nsfwFilter: boolean;
        commercialCleanOnly: boolean;
    };
    privacy: {
        savePrompts: boolean;
        saveTraces: boolean;
        redactPII: boolean;
    };
}

export const DEFAULT_AGENT_SETTINGS: UserAISettings["agent"] = {
    autonomy: "auto",
    maxSteps: 20,
    tokenBudget: 50_000,
    allowDestructive: false,
    voiceInput: true,
    voiceOutput: false,
};
