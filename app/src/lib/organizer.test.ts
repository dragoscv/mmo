import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
    moveTrackToGenreFolder,
    renameTrack,
    sanitizeFilename,
    batchMoveTracks,
    undoMoves,
    undoMove,
} from "./organizer";

let tmpRoot = "";

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-organizer-"));
});

afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const writeFile = (rel: string, body = "x") => {
    const p = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
};

describe("sanitizeFilename", () => {
    it("strips Windows-illegal characters", () => {
        expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')).toBe("abcdefghij");
    });
    it("trims surrounding whitespace", () => {
        expect(sanitizeFilename("  hello  ")).toBe("hello");
    });
});

describe("moveTrackToGenreFolder", () => {
    it("moves a file into <musicRoot>/<genre>/", () => {
        const src = writeFile("inbox/track.mp3");
        const res = moveTrackToGenreFolder(src, tmpRoot, "Techno");
        expect(res.success).toBe(true);
        expect(fs.existsSync(res.newPath)).toBe(true);
        expect(fs.existsSync(src)).toBe(false);
        expect(res.newPath).toBe(path.join(tmpRoot, "Techno", "track.mp3"));
    });

    it("creates the genre folder if it doesn't exist", () => {
        const src = writeFile("inbox/track.mp3");
        const res = moveTrackToGenreFolder(src, tmpRoot, "Tech House");
        expect(res.success).toBe(true);
        expect(fs.statSync(path.join(tmpRoot, "Tech House")).isDirectory()).toBe(true);
    });

    it("renames with a (N) suffix when target already exists", () => {
        writeFile("Techno/track.mp3");
        const src = writeFile("inbox/track.mp3", "different");
        const res = moveTrackToGenreFolder(src, tmpRoot, "Techno");
        expect(res.success).toBe(true);
        expect(res.newPath).toBe(path.join(tmpRoot, "Techno", "track (1).mp3"));
        expect(fs.existsSync(res.newPath)).toBe(true);
    });

    it("returns success=false when source is missing", () => {
        const res = moveTrackToGenreFolder(path.join(tmpRoot, "nope.mp3"), tmpRoot, "X");
        expect(res.success).toBe(false);
        expect(res.error).toBe("File not found");
    });
});

describe("renameTrack", () => {
    it('writes "Artist - Title.ext" in the same folder', () => {
        const src = writeFile("inbox/old.mp3");
        const res = renameTrack(src, "Artist", "Title");
        expect(res.success).toBe(true);
        expect(path.basename(res.newPath)).toBe("Artist - Title.mp3");
        expect(fs.existsSync(res.newPath)).toBe(true);
        expect(fs.existsSync(src)).toBe(false);
    });

    it('appends "(Remix)" when remix is provided', () => {
        const src = writeFile("inbox/old.mp3");
        const res = renameTrack(src, "Artist", "Title", "Club Mix");
        expect(path.basename(res.newPath)).toBe("Artist - Title (Club Mix).mp3");
    });

    it("strips illegal characters from the new name", () => {
        const src = writeFile("inbox/old.mp3");
        const res = renameTrack(src, 'A/B*C', 'D|E?F');
        expect(path.basename(res.newPath)).toBe("ABC - DEF.mp3");
    });

    it("refuses to overwrite an existing target", () => {
        const src = writeFile("inbox/old.mp3");
        writeFile("inbox/Artist - Title.mp3", "blocking");
        const res = renameTrack(src, "Artist", "Title");
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/already exists/i);
        // original is untouched
        expect(fs.existsSync(src)).toBe(true);
    });
});

describe("batchMoveTracks + undoMoves", () => {
    it("moves multiple files and returns one MoveRecord per file moved", () => {
        const a = writeFile("inbox/a.mp3");
        const b = writeFile("inbox/b.mp3");
        const c = writeFile("inbox/c.mp3");
        const res = batchMoveTracks(
            [
                { currentPath: a, genreFolder: "Techno" },
                { currentPath: b, genreFolder: "House" },
                { currentPath: c, genreFolder: "Techno" },
            ],
            tmpRoot,
        );
        expect(res.failures).toEqual([]);
        expect(res.moved).toHaveLength(3);
        for (const r of res.moved) {
            expect(fs.existsSync(r.to)).toBe(true);
            expect(fs.existsSync(r.from)).toBe(false);
        }
    });

    it("collects per-file failures without aborting the batch", () => {
        const ok = writeFile("inbox/ok.mp3");
        const res = batchMoveTracks(
            [
                { currentPath: ok, genreFolder: "Techno" },
                { currentPath: path.join(tmpRoot, "missing.mp3"), genreFolder: "Techno" },
            ],
            tmpRoot,
        );
        expect(res.moved).toHaveLength(1);
        expect(res.failures).toHaveLength(1);
        expect(res.failures[0].error).toBe("File not found");
    });

    it("undoMoves restores files in LIFO order", () => {
        const a = writeFile("inbox/a.mp3");
        const b = writeFile("inbox/b.mp3");
        const moved = batchMoveTracks(
            [
                { currentPath: a, genreFolder: "Techno" },
                { currentPath: b, genreFolder: "House" },
            ],
            tmpRoot,
        ).moved;
        const undone = undoMoves(moved);
        expect(undone.every((u) => u.result.success)).toBe(true);
        expect(fs.existsSync(a)).toBe(true);
        expect(fs.existsSync(b)).toBe(true);
        for (const m of moved) {
            expect(fs.existsSync(m.to)).toBe(false);
        }
    });

    it("undoMove refuses to overwrite if the original path is now occupied", () => {
        const src = writeFile("inbox/track.mp3");
        const moved = moveTrackToGenreFolder(src, tmpRoot, "Techno");
        // Re-create something at the original spot.
        writeFile("inbox/track.mp3", "newer");
        const r = undoMove({ from: src, to: moved.newPath });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/occupied/i);
        // Moved file is still where it was put.
        expect(fs.existsSync(moved.newPath)).toBe(true);
    });
});
