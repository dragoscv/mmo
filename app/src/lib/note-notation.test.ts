import { describe, it, expect } from "vitest";
import {
    formatNoteIndex,
    formatPitch,
    formatNoteMulti,
    formatPitchMulti,
    parseCamelotKey,
    formatCamelotKeyMulti,
} from "./note-notation";

describe("formatNoteIndex", () => {
    it("renders all 12 anglo names", () => {
        const expected = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        for (let i = 0; i < 12; i++) expect(formatNoteIndex(i, "anglo")).toBe(expected[i]);
    });

    it("renders solfège equivalents", () => {
        expect(formatNoteIndex(0, "solfege")).toBe("Do");
        expect(formatNoteIndex(11, "solfege")).toBe("Si");
    });

    it("respects quality for camelot output", () => {
        expect(formatNoteIndex(0, "camelot", "minor")).toBe("5A"); // Cm
        expect(formatNoteIndex(0, "camelot", "major")).toBe("8B"); // C
        expect(formatNoteIndex(9, "camelot", "minor")).toBe("8A"); // Am
    });

    it("wraps negative and >12 indices", () => {
        expect(formatNoteIndex(-1, "anglo")).toBe("B");
        expect(formatNoteIndex(12, "anglo")).toBe("C");
        expect(formatNoteIndex(25, "anglo")).toBe("C#");
    });
});

describe("formatPitch", () => {
    it("appends octave (MIDI-60 = C4)", () => {
        expect(formatPitch(60, "anglo")).toBe("C4");
        expect(formatPitch(69, "anglo")).toBe("A4");
        expect(formatPitch(72, "solfege")).toBe("Do5");
    });

    it("camelot pitch ignores octave (no octave concept)", () => {
        expect(formatPitch(60, "camelot", "major")).toBe("8B"); // C major
        expect(formatPitch(72, "camelot", "major")).toBe("8B");
    });
});

describe("formatNoteMulti / formatPitchMulti", () => {
    it("joins notations with separator", () => {
        expect(formatNoteMulti(0, ["anglo", "solfege"])).toBe("C / Do");
        expect(formatPitchMulti(60, ["anglo", "solfege"], undefined, " · ")).toBe("C4 · Do4");
    });

    it("falls back to anglo when no notations", () => {
        expect(formatNoteMulti(0, [])).toBe("C");
        expect(formatPitchMulti(60, [])).toBe("C4");
    });
});

describe("parseCamelotKey / formatCamelotKeyMulti", () => {
    // Unified DJ-software Camelot convention (Am=8A, C=8B), matching
    // Mixed-In-Key / Rekordbox / Serato and the rest of the codebase
    // (`camelot.ts`, `genre-suggest.ts`). Unified in B35.
    it("parses well-formed camelot codes", () => {
        expect(parseCamelotKey("8A")).toEqual({ noteIndex: 9, quality: "minor" });   // Am
        expect(parseCamelotKey("8b")).toEqual({ noteIndex: 0, quality: "major" });   // C
        expect(parseCamelotKey(" 12B ")).toEqual({ noteIndex: 4, quality: "major" }); // E
    });

    it("returns null for unknown camelot strings", () => {
        expect(parseCamelotKey("13A")).toBeNull();
        expect(parseCamelotKey("nope")).toBeNull();
    });

    it("formatCamelotKeyMulti translates 8A → anglo + solfège (Am)", () => {
        expect(formatCamelotKeyMulti("8A", ["anglo", "solfege"])).toBe("A / La");
    });

    it("returns em-dash for empty/sentinel keys", () => {
        expect(formatCamelotKeyMulti("", ["anglo"])).toBe("—");
        expect(formatCamelotKeyMulti("—", ["anglo"])).toBe("—");
    });
});
