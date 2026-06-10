/**
 * Pure constants and types for generation feedback. Lives outside the
 * `"use server"` boundary so client components can import the constants
 * directly (a server-actions module is only allowed to export async
 * functions).
 */

export const FEEDBACK_REASONS = [
    "wrong-genre",
    "wrong-bpm",
    "wrong-key",
    "off-key",
    "noisy",
    "mushy-vocals",
    "robotic-vocals",
    "too-quiet",
    "too-loud",
    "missing-drop",
    "missing-bass",
    "missing-vocals",
    "boring",
    "amazing",
    "perfect-vibe",
    "use-as-reference",
    "off-tempo",
] as const;

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export type FeedbackVerdict = "up" | "down" | "flag";

export interface RecordFeedbackInput {
    assetId: string;
    verdict: FeedbackVerdict;
    reasons?: FeedbackReason[];
    note?: string;
    score?: number;
}
