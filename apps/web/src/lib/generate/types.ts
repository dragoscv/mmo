/**
 * Shared types/constants for the generative-audio surface.
 * Imported by both server actions and client components, so this
 * file MUST stay free of "use server" and side-effects.
 */

export const GEN_TIERS = ["T0", "T1", "T2"] as const;
export type GenTier = (typeof GEN_TIERS)[number];

export const GEN_TIER_LABELS: Record<GenTier, string> = {
    T0: "Local (companion)",
    T1: "Cloud (Replicate)",
    T2: "External (manual)",
};

export const GEN_KINDS = [
    "one-shot",
    "drum-loop",
    "loop",
    "midi",
    "stem",
    "song",
    "vocal",
] as const;
export type GenKind = (typeof GEN_KINDS)[number];

export const GEN_LICENSES = ["commercial-clean", "personal-use", "unknown"] as const;
export type GenLicense = (typeof GEN_LICENSES)[number];

export interface GenerateRequest {
    tier: GenTier;
    kind: GenKind;
    prompt: string;
    durationSec?: number;
    seed?: number;
    /** T1 model override, e.g. "meta/musicgen". */
    model?: string;
}

export interface GeneratedAssetDto {
    id: string;
    tier: GenTier;
    kind: GenKind;
    model: string | null;
    prompt: string | null;
    license: GenLicense;
    durationSec: number | null;
    sampleRate: number | null;
    fileSize: number | null;
    /** Relative under /api/generated/{id}; null when still pending or failed. */
    fileUrl: string | null;
    /** Set when the asset is a 4-stem split (T0). UI can use this to render mini-players. */
    stemTrackId: number | null;
    /** Set when the asset is a generated song with stems co-located on disk.
     *  Keys are stem names (drums/bass/other/vocals), values are stream URLs. */
    songStems: Record<string, string> | null;
    status: "ready" | "pending" | "failed";
    error: string | null;
    createdAt: string;
}
