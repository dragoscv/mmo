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
// Standard DJ-software Camelot wheel (Mixed-In-Key / Rekordbox / Serato):
//   Minor: G#m=1A, D#m=2A, A#m=3A, Fm=4A, Cm=5A, Gm=6A, Dm=7A, Am=8A,
//          Em=9A, Bm=10A, F#m=11A, C#m=12A
//   Major: B=1B,  F#=2B,  Db=3B,  Ab=4B,  Eb=5B,  Bb=6B,  F=7B,  C=8B,
//          G=9B,  D=10B,  A=11B,  E=12B
// NOTE: This used to follow an Am=1A rotation that conflicted with the rest
// of the codebase (`camelot.ts`, `genre-suggest.ts`) and with every external
// DJ tool the user imports/exports against. Unified in audit round 6 / B35.
const CAMELOT_MINOR: Record<number, string> = {
    8: "1A",   // G#m / Abm
    3: "2A",   // D#m / Ebm
    10: "3A",  // A#m / Bbm
    5: "4A",   // Fm
    0: "5A",   // Cm
    7: "6A",   // Gm
    2: "7A",   // Dm
    9: "8A",   // Am
    4: "9A",   // Em
    11: "10A", // Bm
    6: "11A",  // F#m / Gbm
    1: "12A",  // C#m / Dbm
};

const CAMELOT_MAJOR: Record<number, string> = {
    11: "1B",  // B
    6: "2B",   // F# / Gb
    1: "3B",   // C# / Db
    8: "4B",   // G# / Ab
    3: "5B",   // D# / Eb
    10: "6B",  // A# / Bb
    5: "7B",   // F
    0: "8B",   // C
    7: "9B",   // G
    2: "10B",  // D
    9: "11B",  // A
    4: "12B",  // E
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
