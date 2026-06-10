/** Pure types/defaults for AI user prefs. Importable by both server actions
 *  and client components (avoids "use server" export restrictions). */

export interface AiPrefs {
    "ai.agent.autonomy": "ask" | "propose" | "auto";
    "ai.agent.maxSteps": number;
    "ai.agent.tokenBudget": number;
    "ai.agent.allowDestructive": boolean;
    "ai.agent.voiceInput": boolean;
    "ai.agent.voiceOutput": boolean;
    "ai.privacy.telemetry": boolean;
    "ai.privacy.redactPrompts": boolean;
    "ai.privacy.localOnly": boolean;
    "ai.generation.defaultTier": "T0" | "T1" | "T2";
    "ai.generation.defaultSeed": number | null;
    "ai.generation.licenseFilter": "any" | "commercial-clean" | "personal-use";
}

export const AI_PREFS_DEFAULTS: AiPrefs = {
    "ai.agent.autonomy": "auto",
    "ai.agent.maxSteps": 20,
    "ai.agent.tokenBudget": 50000,
    "ai.agent.allowDestructive": false,
    "ai.agent.voiceInput": true,
    "ai.agent.voiceOutput": false,
    "ai.privacy.telemetry": true,
    "ai.privacy.redactPrompts": false,
    "ai.privacy.localOnly": false,
    "ai.generation.defaultTier": "T1",
    "ai.generation.defaultSeed": null,
    "ai.generation.licenseFilter": "any",
};

export const AI_PREF_KEYS = Object.keys(AI_PREFS_DEFAULTS) as (keyof AiPrefs)[];
