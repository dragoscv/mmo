import { describe, it, expect } from "vitest";
import {
    createHistory,
    pushHistory,
    undoHistory,
    redoHistory,
    jumpToHistory,
    getCurrentSnapshot,
    canUndo,
    canRedo,
    undoCount,
    redoCount,
    clearFuture,
    resetHistory,
} from "./history-engine";

describe("history-engine", () => {
    it("createHistory seeds a single initial entry", () => {
        const h = createHistory({ v: 1 }, "init");
        expect(h.entries).toHaveLength(1);
        expect(h.currentIndex).toBe(0);
        expect(h.entries[0].label).toBe("init");
        expect(getCurrentSnapshot(h)).toEqual({ v: 1 });
        expect(canUndo(h)).toBe(false);
        expect(canRedo(h)).toBe(false);
    });

    it("pushHistory appends and advances pointer", () => {
        let h = createHistory({ v: 1 });
        h = pushHistory(h, { v: 2 }, "step2");
        h = pushHistory(h, { v: 3 }, "step3");
        expect(h.entries).toHaveLength(3);
        expect(h.currentIndex).toBe(2);
        expect(getCurrentSnapshot(h)).toEqual({ v: 3 });
        expect(undoCount(h)).toBe(2);
        expect(redoCount(h)).toBe(0);
    });

    it("undo/redo move the pointer without losing entries", () => {
        let h = createHistory({ v: 1 });
        h = pushHistory(h, { v: 2 }, "a");
        h = pushHistory(h, { v: 3 }, "b");

        h = undoHistory(h);
        expect(getCurrentSnapshot(h)).toEqual({ v: 2 });
        expect(canRedo(h)).toBe(true);

        h = undoHistory(h);
        expect(getCurrentSnapshot(h)).toEqual({ v: 1 });
        expect(canUndo(h)).toBe(false);

        // undo at start is a no-op
        const same = undoHistory(h);
        expect(same).toBe(h);

        h = redoHistory(h);
        h = redoHistory(h);
        expect(getCurrentSnapshot(h)).toEqual({ v: 3 });

        // redo at tip is a no-op
        const tip = redoHistory(h);
        expect(tip).toBe(h);
    });

    it("pushing after undo discards the redo branch", () => {
        let h = createHistory({ v: 1 });
        h = pushHistory(h, { v: 2 }, "a");
        h = pushHistory(h, { v: 3 }, "b");
        h = undoHistory(h); // back to v:2
        h = pushHistory(h, { v: 99 }, "branch");

        expect(h.entries).toHaveLength(3);
        expect(getCurrentSnapshot(h)).toEqual({ v: 99 });
        expect(canRedo(h)).toBe(false);
    });

    it("trims oldest entries when exceeding maxEntries", () => {
        let h = createHistory({ v: 0 }, "init", 3);
        for (let i = 1; i <= 5; i++) {
            h = pushHistory(h, { v: i }, `s${i}`);
        }
        expect(h.entries).toHaveLength(3);
        expect(getCurrentSnapshot(h)).toEqual({ v: 5 });
        // Oldest retained should be v:3 (1,2 dropped, 0 also dropped)
        expect(h.entries[0].snapshot).toEqual({ v: 3 });
    });

    it("jumpToHistory clamps to valid range", () => {
        let h = createHistory({ v: 1 });
        h = pushHistory(h, { v: 2 }, "a");
        h = pushHistory(h, { v: 3 }, "b");

        expect(getCurrentSnapshot(jumpToHistory(h, -10))).toEqual({ v: 1 });
        expect(getCurrentSnapshot(jumpToHistory(h, 999))).toEqual({ v: 3 });
        expect(getCurrentSnapshot(jumpToHistory(h, 1))).toEqual({ v: 2 });
    });

    it("clearFuture drops redo entries", () => {
        let h = createHistory({ v: 1 });
        h = pushHistory(h, { v: 2 }, "a");
        h = pushHistory(h, { v: 3 }, "b");
        h = undoHistory(h);
        h = clearFuture(h);
        expect(h.entries).toHaveLength(2);
        expect(canRedo(h)).toBe(false);
        expect(getCurrentSnapshot(h)).toEqual({ v: 2 });
    });

    it("resetHistory yields a single-entry timeline", () => {
        const h = resetHistory({ v: 42 }, "fresh");
        expect(h.entries).toHaveLength(1);
        expect(h.currentIndex).toBe(0);
        expect(h.entries[0].label).toBe("fresh");
    });
});
