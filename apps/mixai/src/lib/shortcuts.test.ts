// Run: cd apps/mixai; node --test "src/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHORTCUTS_BY_CODE, matchShortcut, type ShortcutKeyEvent } from "./shortcuts.ts";

const key = (code: string, over: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    ...over,
});

test("a bare bound key triggers its shortcut", () => {
    assert.equal(matchShortcut(key("ArrowDown"), false, SHORTCUTS_BY_CODE)?.action, "crossfaderCenter");
    assert.equal(matchShortcut(key("ArrowLeft"), false, SHORTCUTS_BY_CODE)?.arg, -1);
    assert.equal(matchShortcut(key("KeyQ"), false, SHORTCUTS_BY_CODE)?.action, "play");
});

test("a key a focused control already handled is not a shortcut", () => {
    // A list, a lane or a radio group that used the arrow calls preventDefault: the crossfader stays.
    for (const code of ["ArrowLeft", "ArrowRight", "ArrowDown", "KeyQ"]) {
        assert.equal(matchShortcut(key(code, { defaultPrevented: true }), false, SHORTCUTS_BY_CODE), null, code);
    }
});

test("modifier combos and editable fields pass through", () => {
    assert.equal(matchShortcut(key("KeyA", { ctrlKey: true }), false, SHORTCUTS_BY_CODE), null);
    assert.equal(matchShortcut(key("KeyA", { metaKey: true }), false, SHORTCUTS_BY_CODE), null);
    assert.equal(matchShortcut(key("KeyA", { altKey: true }), false, SHORTCUTS_BY_CODE), null);
    assert.equal(matchShortcut(key("ArrowDown"), true, SHORTCUTS_BY_CODE), null);
});

test("an unbound key is not a shortcut", () => {
    assert.equal(matchShortcut(key("ArrowUp"), false, SHORTCUTS_BY_CODE), null);
    assert.equal(matchShortcut(key("KeyQ"), false, new Map()), null);
});
