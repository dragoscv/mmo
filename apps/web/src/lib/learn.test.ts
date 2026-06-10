import { describe, it, expect } from "vitest";
import { extractTitle, pathToSlug, slugToPath } from "./learn";

describe("learn pure helpers", () => {
    describe("extractTitle", () => {
        it("returns first H1", () => {
            expect(extractTitle("# Hello world\n\nbody", "fb")).toBe("Hello world");
        });

        it("strips inline markdown decoration", () => {
            expect(extractTitle("# **Bold** _title_ `code`", "fb")).toBe("Bold title code");
        });

        it("ignores H2/H3", () => {
            expect(extractTitle("## not me\n### nor me\n# real one", "fb")).toBe("real one");
        });

        it("falls back when no heading is found", () => {
            expect(extractTitle("plain body, no heading", "fallback-slug")).toBe("fallback-slug");
        });

        it("handles CRLF line endings", () => {
            expect(extractTitle("# crlf\r\nbody", "fb")).toBe("crlf");
        });
    });

    describe("pathToSlug / slugToPath", () => {
        it("encodes forward slashes as dots", () => {
            expect(pathToSlug("arhitectura/01-prezentare.md")).toBe("arhitectura.01-prezentare");
        });

        it("encodes backslashes as dots (Windows-friendly)", () => {
            expect(pathToSlug("arhitectura\\01-prezentare.md")).toBe("arhitectura.01-prezentare");
        });

        it("strips .md case-insensitively", () => {
            expect(pathToSlug("README.MD")).toBe("README");
        });

        it("round-trips simple paths", () => {
            const rel = "arhitectura/01-prezentare-generala.md";
            expect(slugToPath(pathToSlug(rel))).toBe(rel);
        });

        it("flat slug round-trips", () => {
            expect(slugToPath(pathToSlug("glosar.md"))).toBe("glosar.md");
        });
    });
});
