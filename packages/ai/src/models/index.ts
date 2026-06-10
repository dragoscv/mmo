/**
 * Role-based model assignment. Users pick which model fulfills which
 * functional role; the agent runtime resolves a role to a concrete
 * (provider, modelId) pair at call time.
 */

import type { ProviderId } from "../providers/types";

export const MODEL_ROLES = [
    "chat",
    "agent",
    "tag",
    "embed",
    "vision",
    "audio-caption",
    "lyrics",
    "music-full",
    "music-loop",
    "music-stem",
    "music-vocal",
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export const MODEL_ROLE_LABELS: Record<ModelRole, string> = {
    chat: "Chat (UI side-panel)",
    agent: "Agent (Maestro tool-calling)",
    tag: "Tagging & classification",
    embed: "Embeddings (RAG)",
    vision: "Vision (album art / waveform)",
    "audio-caption": "Audio → text captioning",
    lyrics: "Lyrics writing",
    "music-full": "Full song generation",
    "music-loop": "Loop / sample generation",
    "music-stem": "Stem generation",
    "music-vocal": "Vocal generation",
};

export interface ModelChoice {
    role: ModelRole;
    provider: ProviderId;
    modelId: string;
    params?: Record<string, unknown>;
}

export interface ModelChoices {
    byRole: Partial<Record<ModelRole, ModelChoice>>;
}

export function pickModelForRole(choices: ModelChoices, role: ModelRole): ModelChoice | undefined {
    return choices.byRole[role];
}
