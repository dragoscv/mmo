export function suggestGenre(bpm: number): string {
    if (bpm >= 150) return "Bounce";
    if (bpm >= 145) return "Psytrance";
    if (bpm >= 138) return "Psytrance";
    if (bpm >= 130) return "Techno";
    if (bpm >= 125) return "Techno";
    if (bpm >= 122) return "Tech House";
    if (bpm >= 115) return "Other";
    if (bpm >= 85) return "Other"; // Could be Manele, Latino, etc. — ambiguous
    return "Other";
}

// Musical key to Camelot wheel mapping
const KEY_TO_CAMELOT: Record<string, string> = {
    // Minor keys (A)
    Abm: "1A",
    "G#m": "1A",
    Ebm: "2A",
    "D#m": "2A",
    Bbm: "3A",
    "A#m": "3A",
    Fm: "4A",
    Cm: "5A",
    Gm: "6A",
    Dm: "7A",
    Am: "8A",
    Em: "9A",
    Bm: "10A",
    "F#m": "11A",
    "Gbm": "11A",
    "C#m": "12A",
    "Dbm": "12A",

    // Major keys (B)
    B: "1B",
    "Cb": "1B",
    "F#": "2B",
    "Gb": "2B",
    "C#": "3B",
    "Db": "3B",
    Ab: "4B",
    "G#": "4B",
    Eb: "5B",
    "D#": "5B",
    Bb: "6B",
    "A#": "6B",
    F: "7B",
    C: "8B",
    G: "9B",
    D: "10B",
    A: "11B",
    E: "12B",
};

export function musicalKeyToCamelot(key: string): string | null {
    if (!key) return null;

    // Normalize key string
    const normalized = key
        .trim()
        .replace(/\s*(minor|min|mol)\s*/i, "m")
        .replace(/\s*(major|maj|dur)\s*/i, "")
        .replace(/flat/i, "b")
        .replace(/sharp/i, "#");

    return KEY_TO_CAMELOT[normalized] ?? null;
}

export function camelotToMusicalKey(camelot: string): string | null {
    const CAMELOT_TO_KEY: Record<string, string> = {
        "1A": "Abm", "2A": "Ebm", "3A": "Bbm", "4A": "Fm", "5A": "Cm",
        "6A": "Gm", "7A": "Dm", "8A": "Am", "9A": "Em", "10A": "Bm",
        "11A": "F#m", "12A": "C#m",
        "1B": "B", "2B": "F#", "3B": "Db", "4B": "Ab", "5B": "Eb",
        "6B": "Bb", "7B": "F", "8B": "C", "9B": "G", "10B": "D",
        "11B": "A", "12B": "E",
    };
    return CAMELOT_TO_KEY[camelot] ?? null;
}

/**
 * Get harmonic compatibility score between two Camelot keys.
 * Returns: 0 = perfect match, 1 = compatible, 2 = near compatible, 3 = clash, -1 = unknown
 */
export function getHarmonicScore(key1: string | null | undefined, key2: string | null | undefined): number {
    if (!key1 || !key2) return -1;

    if (key1 === key2) return 0; // Same key

    const match1 = key1.match(/^(\d+)(A|B)$/);
    const match2 = key2.match(/^(\d+)(A|B)$/);
    if (!match1 || !match2) return -1;

    const num1 = parseInt(match1[1]);
    const letter1 = match1[2];
    const num2 = parseInt(match2[1]);
    const letter2 = match2[2];

    // Same number, different letter = relative major/minor (compatible)
    if (num1 === num2 && letter1 !== letter2) return 1;

    // Same letter, adjacent numbers (+1 or -1 on camelot wheel)
    if (letter1 === letter2) {
        const diff = Math.min(
            Math.abs(num1 - num2),
            12 - Math.abs(num1 - num2)
        );
        if (diff === 1) return 1; // Adjacent = compatible
        if (diff === 2) return 2; // Near = okay
    }

    // Different letter, adjacent numbers
    if (letter1 !== letter2) {
        const diff = Math.min(
            Math.abs(num1 - num2),
            12 - Math.abs(num1 - num2)
        );
        if (diff === 1) return 2; // Cross-adjacent = near
    }

    return 3; // Clash
}

export function getCompatibleKeys(camelot: string): string[] {
    const match = camelot.match(/^(\d+)(A|B)$/);
    if (!match) return [];

    const num = parseInt(match[1]);
    const letter = match[2];

    const compatible: string[] = [
        camelot, // Same key
        `${num}${letter === "A" ? "B" : "A"}`, // Relative major/minor
        `${((num % 12) + 1)}${letter}`, // +1 (up fifth)
        `${((num - 2 + 12) % 12) + 1}${letter}`, // -1 (down fifth)
    ];

    return compatible;
}
