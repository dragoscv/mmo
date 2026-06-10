import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
}

// ─── Audio ───────────────────────────────────────────────────────────────────

export const AUDIO_EXTENSIONS = new Set([
    ".mp3", ".flac", ".wav", ".aac", ".ogg", ".m4a", ".wma", ".aiff", ".aif", ".alac", ".opus",
]);

// ─── Formatting ──────────────────────────────────────────────────────────────

export function formatDuration(seconds?: number | null): string {
    if (!seconds) return "—";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatNumber(n: number): string {
    return n.toLocaleString("en-US");
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

import { formatCamelotKeyMulti, type NoteNotation } from "@/lib/note-notation";

export function formatKey(camelot?: string | null, notations?: NoteNotation[]): string {
    if (!camelot) return "—";
    if (!notations) return camelot; // fallback: raw Camelot
    return formatCamelotKeyMulti(camelot, notations);
}

// ─── Harmonic Mixing ─────────────────────────────────────────────────────────

const CAMELOT_WHEEL: Record<string, number> = {
    "1A": 1, "1B": 2, "2A": 3, "2B": 4, "3A": 5, "3B": 6,
    "4A": 7, "4B": 8, "5A": 9, "5B": 10, "6A": 11, "6B": 12,
    "7A": 13, "7B": 14, "8A": 15, "8B": 16, "9A": 17, "9B": 18,
    "10A": 19, "10B": 20, "11A": 21, "11B": 22, "12A": 23, "12B": 24,
};

export function getHarmonicColor(
    key1?: string | null,
    key2?: string | null
): string {
    if (!key1 || !key2) return "";
    const k1 = key1.toUpperCase().trim();
    const k2 = key2.toUpperCase().trim();
    if (k1 === k2) return "text-green-400";

    // Same number different letter (A↔B)
    const num1 = k1.replace(/[AB]/, "");
    const num2 = k2.replace(/[AB]/, "");
    const letter1 = k1.slice(-1);
    const letter2 = k2.slice(-1);

    if (num1 === num2 && letter1 !== letter2) return "text-green-400";

    // Adjacent keys (±1 on same letter)
    if (letter1 === letter2) {
        const n1 = parseInt(num1);
        const n2 = parseInt(num2);
        const diff = Math.abs(n1 - n2);
        if (diff === 1 || diff === 11) return "text-yellow-400";
    }

    return "text-red-400";
}

// ─── Energy ──────────────────────────────────────────────────────────────────

export const ENERGY_COLORS: Record<number, string> = {
    1: "bg-blue-500",
    2: "bg-cyan-500",
    3: "bg-teal-500",
    4: "bg-green-500",
    5: "bg-lime-500",
    6: "bg-yellow-500",
    7: "bg-amber-500",
    8: "bg-orange-500",
    9: "bg-red-500",
    10: "bg-rose-500",
};

export const ENERGY_LABELS: Record<number, string> = {
    1: "Very Low",
    2: "Low",
    3: "Low-Med",
    4: "Medium",
    5: "Medium",
    6: "Med-High",
    7: "High",
    8: "High",
    9: "Very High",
    10: "Peak",
};

// ─── Genre Colors ────────────────────────────────────────────────────────────

export const GENRE_COLORS: Record<string, string> = {
    "House": "bg-purple-500/20 text-purple-400",
    "Tech House": "bg-violet-500/20 text-violet-400",
    "Deep House": "bg-indigo-500/20 text-indigo-400",
    "Progressive House": "bg-blue-500/20 text-blue-400",
    "Techno": "bg-zinc-500/20 text-zinc-300",
    "Melodic Techno": "bg-slate-500/20 text-slate-300",
    "Trance": "bg-cyan-500/20 text-cyan-400",
    "Psytrance": "bg-emerald-500/20 text-emerald-400",
    "Drum & Bass": "bg-amber-500/20 text-amber-400",
    "Dubstep": "bg-red-500/20 text-red-400",
    "EDM": "bg-pink-500/20 text-pink-400",
    "Electro": "bg-yellow-500/20 text-yellow-400",
    "Hip Hop": "bg-orange-500/20 text-orange-400",
    "R&B": "bg-rose-500/20 text-rose-400",
    "Pop": "bg-fuchsia-500/20 text-fuchsia-400",
    "Rock": "bg-stone-500/20 text-stone-400",
    "Latin": "bg-lime-500/20 text-lime-400",
    "Reggaeton": "bg-green-500/20 text-green-400",
    "Afrobeat": "bg-teal-500/20 text-teal-400",
    "Disco": "bg-sky-500/20 text-sky-400",
    "Funk": "bg-amber-600/20 text-amber-500",
    "Jazz": "bg-blue-600/20 text-blue-500",
    "Classical": "bg-neutral-500/20 text-neutral-400",
    "Ambient": "bg-gray-500/20 text-gray-400",
    "Downtempo": "bg-slate-400/20 text-slate-300",
    "Breakbeat": "bg-orange-600/20 text-orange-500",
    "Garage": "bg-violet-600/20 text-violet-500",
    "Minimal": "bg-zinc-400/20 text-zinc-300",
    "Hardstyle": "bg-red-600/20 text-red-500",
    "Hardcore": "bg-rose-600/20 text-rose-500",
    "Loop Samples": "bg-emerald-800/20 text-emerald-500",
    "Other": "bg-zinc-500/20 text-zinc-400",
};
