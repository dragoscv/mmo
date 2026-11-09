// Run: node --test apps/mixai/src/library/window-state.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialWindow, visibleRange, windowState, type WindowAction, type WindowState } from "./window-state.ts";

const s0 = (p: Partial<WindowState>): WindowState => windowState({ ...initialWindow, ...p }, { type: "setTotal", n: p.total ?? 0 });

function invariants(s: WindowState, label: string) {
    assert.ok(Number.isInteger(s.total) && s.total >= 0, `${label}: total`);
    assert.ok(Number.isInteger(s.visible) && s.visible >= 1, `${label}: visible`);
    assert.ok(s.offset >= 0 && s.offset <= Math.max(0, s.total - s.visible), `${label}: offset ${s.offset}`);
    if (s.total === 0) {
        assert.equal(s.cursor, 0, `${label}: cursor on empty`);
        assert.equal(s.offset, 0, `${label}: offset on empty`);
    } else {
        assert.ok(s.cursor >= 0 && s.cursor < s.total, `${label}: cursor in list`);
        assert.ok(s.offset <= s.cursor && s.cursor < s.offset + s.visible, `${label}: cursor ${s.cursor} in window ${s.offset}+${s.visible}`);
    }
}

test("move follows the cursor and clamps at both ends", () => {
    let s = s0({ total: 100, visible: 10 });
    s = windowState(s, { type: "move", n: 9 });
    assert.deepEqual([s.offset, s.cursor], [0, 9]);
    s = windowState(s, { type: "move", n: 1 });
    assert.deepEqual([s.offset, s.cursor], [1, 10]);
    s = windowState(s, { type: "move", n: -1000 });
    assert.deepEqual([s.offset, s.cursor], [0, 0]);
    s = windowState(s, { type: "move", n: 1000 });
    assert.deepEqual([s.offset, s.cursor], [90, 99]);
});

test("page, home, end", () => {
    let s = s0({ total: 25, visible: 10 });
    s = windowState(s, { type: "page", dir: 1 });
    assert.deepEqual([s.offset, s.cursor], [10, 10]);
    s = windowState(s, { type: "page", dir: 1 });
    assert.deepEqual([s.offset, s.cursor], [15, 20]);
    s = windowState(s, { type: "page", dir: -1 });
    assert.deepEqual([s.offset, s.cursor], [5, 10]);
    s = windowState(s, { type: "end" });
    assert.deepEqual([s.offset, s.cursor], [15, 24]);
    s = windowState(s, { type: "home" });
    assert.deepEqual([s.offset, s.cursor], [0, 0]);
});

test("scroll shifts the window and drags the cursor only when it would leave", () => {
    let s = s0({ total: 50, visible: 5 });
    s = windowState(s, { type: "jumpTo", index: 3 });
    s = windowState(s, { type: "scroll", n: 2 });
    assert.deepEqual([s.offset, s.cursor], [2, 3]);
    s = windowState(s, { type: "scroll", n: 10 });
    assert.deepEqual([s.offset, s.cursor], [12, 12]);
    s = windowState(s, { type: "scroll", n: -100 });
    assert.deepEqual([s.offset, s.cursor], [0, 4]);
});

test("setVisible / setTotal keep the cursor in view; total 0 is handled", () => {
    let s = s0({ total: 100, visible: 20 });
    s = windowState(s, { type: "jumpTo", index: 19 });
    s = windowState(s, { type: "setVisible", n: 5 });
    assert.deepEqual([s.offset, s.cursor, s.visible], [15, 19, 5]);
    s = windowState(s, { type: "setTotal", n: 10 });
    assert.deepEqual([s.offset, s.cursor], [5, 9]);
    s = windowState(s, { type: "setTotal", n: 0 });
    assert.deepEqual(s, { total: 0, visible: 5, offset: 0, cursor: 0 });
    for (const a of [{ type: "move", n: 3 }, { type: "page", dir: 1 }, { type: "end" }, { type: "home" }, { type: "scroll", n: 4 }, { type: "jumpTo", index: 7 }] as WindowAction[])
        invariants(windowState(s, a), `empty ${a.type}`);
    s = windowState(s, { type: "setVisible", n: 0 });
    assert.equal(s.visible, 1);
    s = windowState(s, { type: "setVisible", n: Number.NaN });
    assert.equal(s.visible, 1);
});

test("fewer rows than fit: offset stays 0", () => {
    let s = s0({ total: 3, visible: 10 });
    s = windowState(s, { type: "end" });
    assert.deepEqual([s.offset, s.cursor], [0, 2]);
    assert.deepEqual(visibleRange(s), { from: 1, to: 3, total: 3 });
});

test("visibleRange", () => {
    assert.deepEqual(visibleRange(s0({ total: 0, visible: 4 })), { from: 0, to: 0, total: 0 });
    let s = s0({ total: 4812, visible: 19 });
    s = windowState(s, { type: "jumpTo", index: 329 });
    assert.deepEqual(visibleRange(s), { from: 312, to: 330, total: 4812 });
});

test("sweep: random actions never break the invariants", () => {
    let seed = 0x5eed;
    const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
    };
    let s: WindowState = { ...initialWindow };
    for (let i = 0; i < 20000; i++) {
        const k = rnd(8);
        const n = rnd(60) - 30;
        const a: WindowAction =
            k === 0 ? { type: "move", n }
            : k === 1 ? { type: "page", dir: n }
            : k === 2 ? { type: "home" }
            : k === 3 ? { type: "end" }
            : k === 4 ? { type: "scroll", n }
            : k === 5 ? { type: "setVisible", n: rnd(40) - 2 }
            : k === 6 ? { type: "setTotal", n: rnd(5) === 0 ? 0 : rnd(200) }
            : { type: "jumpTo", index: rnd(250) - 20 };
        s = windowState(s, a);
        invariants(s, `step ${i} ${a.type}`);
    }
});
