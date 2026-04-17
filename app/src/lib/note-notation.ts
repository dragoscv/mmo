/**
 * Musical Note Notation System
 *
 * Three notation formats:
 * - Anglo (letter): C, C#, D, D#, E, F, F#, G, G#, A, A#, B
 * - Solfège (classical): Do, Do#, Re, Re#, Mi, Fa, Fa#, Sol, Sol#, La, La#, Si
 * - Camelot (DJ numeric): 1A–12A (minor), 1B–12B (major)
 *
 * Settings allow choosing up to 2 notations displayed simultaneously.
 */

export type NoteNotation = "anglo" | "solfege" | "camelot";

export const NOTATION_LABELS: Record<NoteNotation, string> = {
    anglo: "Letter (C, D, E…)",
    solfege: "Classical (Do, Re, Mi…)",
    camelot: "Camelot (1A, 2B…)",
};

// ─── Lookup Tables ───────────────────────────────────────────────────────

const ANGLO_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const SOLFEGE_NAMES = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];

// Camelot mapping: noteIndex (0–11) → { minor: "XA", major: "XB" }
// Standard Camelot wheel: Am=1A, Em=2A, Bm=3A, F#m=4A, C#m=5A, G#m=6A,
// Ebm=7A, Bbm=8A, Fm=9A, Cm=10A, Gm=11A, Dm=12A
// Parallel major: C=1B, G=2B, D=3B, A=4B, E=5B, B=6B,
// F#=7B, Db=8B, Ab=9B, Eb=10B, Bb=11B, F=12B
const CAMELOT_MINOR: Record<number, string> = {
    9: "1A",   // Am
    4: "2A",   // Em
    11: "3A",  // Bm
    6: "4A",   // F#m
    1: "5A",   // C#m
    8: "6A",   // G#m
    3: "7A",   // Ebm
    10: "8A",  // Bbm
    5: "9A",   // Fm
    0: "10A",  // Cm
    7: "11A",  // Gm
    2: "12A",  // Dm
};

const CAMELOT_MAJOR: Record<number, string> = {
    0: "1B",   // C
    7: "2B",   // G
    2: "3B",   // D
    9: "4B",   // A
    4: "5B",   // E
    11: "6B",  // B
    6: "7B",   // F#
    1: "8B",   // Db
    8: "9B",   // Ab
    3: "10B",  // Eb
    10: "11B", // Bb
    5: "12B",  // F
};

// Reverse lookup: Camelot string → noteIndex
const CAMELOT_TO_NOTE: Record<string, { noteIndex: number; quality: "minor" | "major" }> = {};
for (const [noteStr, cam] of Object.entries(CAMELOT_MINOR)) {
    CAMELOT_TO_NOTE[cam] = { noteIndex: Number(noteStr), quality: "minor" };
}
for (const [noteStr, cam] of Object.entries(CAMELOT_MAJOR)) {
    CAMELOT_TO_NOTE[cam] = { noteIndex: Number(noteStr), quality: "major" };
}

// ─── Core Format Functions ───────────────────────────────────────────────

/** Format a note index (0–11) in a given notation. Camelot needs quality hint. */
export function formatNoteIndex(
    noteIndex: number,
    notation: NoteNotation,
    quality?: "major" | "minor",
): string {
    const idx = ((noteIndex % 12) + 12) % 12;
    switch (notation) {
        case "anglo":
            return ANGLO_NAMES[idx];
        case "solfege":
            return SOLFEGE_NAMES[idx];
        case "camelot":
            return (quality === "major" ? CAMELOT_MAJOR[idx] : CAMELOT_MINOR[idx]) ?? ANGLO_NAMES[idx];
    }
}

/** Format a full pitch (MIDI noteIndex with octave) like "C4" / "Do4" / "8B" */
export function formatPitch(
    midiNote: number,
    notation: NoteNotation,
    quality?: "major" | "minor",
): string {
    const noteIdx = ((midiNote % 12) + 12) % 12;
    const octave = Math.floor(midiNote / 12) - 1;
    switch (notation) {
        case "anglo":
            return `${ANGLO_NAMES[noteIdx]}${octave}`;
        case "solfege":
            return `${SOLFEGE_NAMES[noteIdx]}${octave}`;
        case "camelot":
            // Camelot doesn't have octave concept — fall back to Camelot code
            return (quality === "major" ? CAMELOT_MAJOR[noteIdx] : CAMELOT_MINOR[noteIdx]) ?? `${ANGLO_NAMES[noteIdx]}${octave}`;
    }
}

/** Format a note index with up to 2 notations, joined by separator */
export function formatNoteMulti(
    noteIndex: number,
    notations: NoteNotation[],
    quality?: "major" | "minor",
    separator = " / ",
): string {
    if (notations.length === 0) return ANGLO_NAMES[((noteIndex % 12) + 12) % 12];
    return notations
        .map(n => formatNoteIndex(noteIndex, n, quality))
        .join(separator);
}

/** Format a full pitch with up to 2 notations */
export function formatPitchMulti(
    midiNote: number,
    notations: NoteNotation[],
    quality?: "major" | "minor",
    separator = " / ",
): string {
    if (notations.length === 0) return formatPitch(midiNote, "anglo");
    return notations
        .map(n => formatPitch(midiNote, n, quality))
        .join(separator);
}

/** Parse a Camelot key string (e.g. "8A", "11B") into noteIndex + quality */
export function parseCamelotKey(camelot: string): { noteIndex: number; quality: "major" | "minor" } | null {
    const upper = camelot.toUpperCase().trim();
    return CAMELOT_TO_NOTE[upper] ?? null;
}

/** Format a Camelot key string (e.g. "8A") using the selected notations */
export function formatCamelotKeyMulti(
    camelotKey: string,
    notations: NoteNotation[],
    separator = " / ",
): string {
    if (!camelotKey || camelotKey === "—") return "—";
    const parsed = parseCamelotKey(camelotKey);
    if (!parsed) return camelotKey; // Unknown format, return as-is
    return formatNoteMulti(parsed.noteIndex, notations, parsed.quality, separator);
}

// ─── Exports for backward compat ─────────────────────────────────────────

export { ANGLO_NAMES, SOLFEGE_NAMES, CAMELOT_MINOR, CAMELOT_MAJOR, CAMELOT_TO_NOTE };
