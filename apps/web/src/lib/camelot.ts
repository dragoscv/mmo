/**
 * Convert (chromaticIndex 0-11, scaleIndex 0=minor|1=major) → Camelot wheel.
 * Used by Live + remote to query key-compatible recommendations.
 */
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function toCamelot(keyIndex: number, scaleIndex: number): string {
    const idx = ((keyIndex % 12) + 12) % 12;
    return scaleIndex === 1 ? CAMELOT_MAJOR[idx] : CAMELOT_MINOR[idx];
}

export function keyName(keyIndex: number, scaleIndex: number): string {
    const idx = ((keyIndex % 12) + 12) % 12;
    return `${NOTE_NAMES[idx]} ${scaleIndex === 1 ? "Major" : "Minor"}`;
}
