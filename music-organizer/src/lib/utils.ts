import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { camelotToMusicalKey, getHarmonicScore } from "./genre-suggest";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function formatDuration(seconds: number | null | undefined): string {
    if (!seconds) return "—";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatFileSize(bytes: number | null | undefined): string {
    if (!bytes) return "—";
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const ENERGY_COLORS: Record<number, string> = {
    1: "bg-blue-500",
    2: "bg-green-500",
    3: "bg-yellow-500",
    4: "bg-orange-500",
    5: "bg-red-500",
};

export const ENERGY_LABELS: Record<number, string> = {
    1: "Ambient",
    2: "Warmup",
    3: "Groove",
    4: "Drive",
    5: "Peak",
};

export const GENRE_COLORS: Record<string, string> = {
    Techno: "bg-zinc-700 text-zinc-100",
    "Tech House": "bg-emerald-700 text-emerald-100",
    Acid: "bg-lime-600 text-lime-100",
    Psytrance: "bg-purple-700 text-purple-100",
    Bounce: "bg-red-600 text-red-100",
    Manele: "bg-amber-600 text-amber-100",
    "Populară": "bg-sky-700 text-sky-100",
    "Balkanică": "bg-orange-700 text-orange-100",
    Latino: "bg-pink-600 text-pink-100",
    Other: "bg-neutral-600 text-neutral-200",
};

export const AUDIO_EXTENSIONS = new Set([
    ".mp3",
    ".flac",
    ".wav",
    ".aiff",
    ".aif",
    ".m4a",
    ".aac",
    ".ogg",
    ".wma",
]);

/**
 * Format a Camelot key with its classic musical equivalent.
 * e.g. "8A" → "8A · Am", "1B" → "1B · B"
 */
export function formatKey(camelot: string | null | undefined, musical?: string | null): string {
    if (!camelot) return "—";
    const classic = musical || camelotToMusicalKey(camelot);
    if (classic) return `${camelot} · ${classic}`;
    return camelot;
}

/**
 * Get a CSS class for harmonic similarity coloring.
 * Score: 0=perfect, 1=compatible, 2=near, 3=clash, -1=unknown
 */
export const HARMONIC_COLORS: Record<number, string> = {
    0: "bg-green-500/20 border-l-2 border-l-green-500",   // Perfect match
    1: "bg-emerald-500/12 border-l-2 border-l-emerald-400", // Compatible
    2: "bg-yellow-500/8 border-l-2 border-l-yellow-500",    // Near
    3: "",                                                    // Clash - no color
    [-1]: "",                                                 // Unknown
};

export function getHarmonicColor(
    trackKey: string | null | undefined,
    currentKey: string | null | undefined
): string {
    const score = getHarmonicScore(trackKey, currentKey);
    return HARMONIC_COLORS[score] || "";
}
