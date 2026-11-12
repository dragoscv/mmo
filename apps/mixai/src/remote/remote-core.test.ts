// Run: node --test apps/mixai/src/remote/remote-core.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLabels, consumeBareArrows, countStatus, cutCodePoints, decisionsFor, errorDetail, errorKind, errorText, findQuery, focusRowAfter, hostOf, isBareArrow, isMissingFeature, labelsKey, newPending, pageOf, pagerTarget, parseQrSvg, rovingTarget, type LabelDeck } from "./remote-core.ts";
import { SHORTCUTS_BY_CODE, matchShortcut } from "../lib/shortcuts.ts";

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><path fill="currentColor" d="';
const TAIL = '"/></svg>';
const SQUARES = "M4 4h1v1h-1zM5 4h1v1h-1zM24 24h1v1h-1z";

/** No lone surrogate: every high one is followed by a low one and every low one follows a high one. */
function wellFormed(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = s.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
            i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) return false;
    }
    return true;
}

test("the QR SVG of the shell is parsed into a size and a path", () => {
    assert.deepEqual(parseQrSvg(HEAD + SQUARES + TAIL), { size: 29, d: SQUARES });
    const big = HEAD.replace("0 0 29 29", "0 0 185 185") + "M180 180h1v1h-1z" + TAIL;
    assert.deepEqual(parseQrSvg(big), { size: 185, d: "M180 180h1v1h-1z" });
});

test("anything that is not exactly that shape is refused", () => {
    for (const bad of [
        null,
        undefined,
        "",
        "<svg></svg>",
        HEAD + TAIL, // no module
        HEAD + SQUARES + '"/><script>alert(1)</script></svg>',
        HEAD + SQUARES + '" onload="alert(1)' + TAIL,
        HEAD + "M4 4h1v1h-1z L0 0" + TAIL,
        HEAD + "M4 4h9v9h-9z" + TAIL, // not a unit square
        HEAD.replace("0 0 29 29", "0 0 29 30") + SQUARES + TAIL, // not square
        HEAD.replace("0 0 29 29", "0 0 9 9") + SQUARES + TAIL, // smaller than a version 1 code
        HEAD.replace("0 0 29 29", "0 0 999 999") + SQUARES + TAIL,
        HEAD.replace('fill="currentColor"', 'fill="red"') + SQUARES + TAIL,
        " " + HEAD + SQUARES + TAIL,
        HEAD + SQUARES + TAIL + "\n<img src=x>",
    ]) {
        assert.equal(parseQrSvg(bad), null, String(bad).slice(0, 60));
    }
    // Far larger than any QR code: refused before the pattern runs.
    assert.equal(parseQrSvg(HEAD + "M4 4h1v1h-1z".repeat(60_000) + TAIL), null);
});

test("decisions per status", () => {
    assert.deepEqual(decisionsFor("pending"), ["accepted", "rejected"]);
    assert.deepEqual(decisionsFor("accepted"), ["played", "rejected"]);
    assert.deepEqual(decisionsFor("rejected"), ["accepted"]);
    assert.deepEqual(decisionsFor("played"), []);
});

test("counting by status", () => {
    const list = [{ status: "pending" }, { status: "accepted" }, { status: "pending" }, { status: "played" }] as const;
    assert.equal(countStatus(list, "pending"), 2);
    assert.equal(countStatus(list, "accepted"), 1);
    assert.equal(countStatus(list, "rejected"), 0);
    assert.equal(countStatus([], "pending"), 0);
});

test("paging clamps to the list", () => {
    const list = [1, 2, 3, 4, 5, 6, 7];
    assert.deepEqual(pageOf(list, 0, 3), { items: [1, 2, 3], page: 0, pages: 3 });
    assert.deepEqual(pageOf(list, 2, 3), { items: [7], page: 2, pages: 3 });
    assert.deepEqual(pageOf(list, 9, 3), { items: [7], page: 2, pages: 3 }, "the list shrank under the cursor");
    assert.deepEqual(pageOf(list, -4, 3), { items: [1, 2, 3], page: 0, pages: 3 });
    assert.deepEqual(pageOf(list, Number.NaN, 3), { items: [1, 2, 3], page: 0, pages: 3 });
    assert.deepEqual(pageOf([], 1, 3), { items: [], page: 0, pages: 1 });
    assert.deepEqual(pageOf(list, 0, 0), { items: [1], page: 0, pages: 7 });
    assert.deepEqual(pageOf([1, 2, 3], 0, 3), { items: [1, 2, 3], page: 0, pages: 1 });
});

test("library search text of a request", () => {
    assert.equal(findQuery("Strobe", "deadmau5"), "Strobe deadmau5");
    assert.equal(findQuery("  One   More  Time ", ""), "One More Time");
    assert.equal(findQuery("", ""), "");
    assert.equal(findQuery("x".repeat(300), "y").length, 200);
});

test("the search text is cut by code point, never through an emoji", () => {
    // 199 letters then an emoji (two UTF-16 units): a slice at 200 units would leave half of it.
    const q = findQuery("x".repeat(199) + "🎧", "y");
    assert.equal(Array.from(q).length, 200);
    assert.equal(Array.from(q).at(-1), "🎧", "the emoji is whole");
    assert.equal(q.length, 201, "199 letters + one emoji of two UTF-16 units");
    assert.ok(wellFormed(q), "no lone surrogate");
    // What the old cut did: 200 UTF-16 units = 199 letters and HALF of the emoji.
    assert.equal(wellFormed(("x".repeat(199) + "🎧 y").slice(0, 200)), false, "the check sees a lone surrogate");
    const only = findQuery("🎧".repeat(250), "");
    assert.equal(Array.from(only).length, 200);
    assert.ok(wellFormed(only));
    assert.equal(cutCodePoints("héllo", 2), "hé");
    assert.equal(cutCodePoints("", 5), "");
    assert.equal(cutCodePoints("ab", 0), "");
    assert.ok(wellFormed(errorText("é".repeat(199) + "💥💥")));
});

const deck = (id: string, patch: Partial<LabelDeck> = {}): LabelDeck => ({ id, loaded: true, trackId: `t-${id}`, title: `Title ${id}`, artist: `Artist ${id}`, ...patch });

test("labels: one per deck, empty for an unloaded deck, cue point sanitised", () => {
    const decks = [deck("a"), deck("b", { loaded: false }), deck("c", { artist: null }), deck("d")];
    const cue: Record<string, number> = { a: 12.5, b: 99, c: Number.NaN, d: -3 };
    assert.deepEqual(
        buildLabels(decks, (d) => cue[d.id]!),
        [
            { deck: "a", trackId: "t-a", title: "Title a", artist: "Artist a", cueSec: 12.5 },
            { deck: "b", trackId: null, title: null, artist: null, cueSec: 0 },
            { deck: "c", trackId: "t-c", title: "Title c", artist: null, cueSec: 0 },
            { deck: "d", trackId: "t-d", title: "Title d", artist: "Artist d", cueSec: 0 },
        ],
    );
});

test("the labels key changes with a title, a track or a cue point, and only then", () => {
    const base = buildLabels([deck("a"), deck("b")], () => 0);
    const key = labelsKey(base);
    assert.equal(labelsKey(buildLabels([deck("a"), deck("b")], () => 0)), key);
    assert.notEqual(labelsKey(buildLabels([deck("a", { title: "Other" }), deck("b")], () => 0)), key);
    assert.notEqual(labelsKey(buildLabels([deck("a", { trackId: "t-x" }), deck("b")], () => 0)), key);
    assert.notEqual(labelsKey(buildLabels([deck("a"), deck("b", { loaded: false })], () => 0)), key);
    assert.notEqual(labelsKey(buildLabels([deck("a"), deck("b")], (d) => (d.id === "b" ? 4.25 : 0))), key);
    // Sub-millisecond noise in a cue point is not a change.
    assert.equal(labelsKey(buildLabels([deck("a"), deck("b")], () => 0.0001)), key);
    // A value moving from one field to the next is a change.
    assert.notEqual(labelsKey(buildLabels([deck("a", { title: "ab", artist: "c" })], () => 0)), labelsKey(buildLabels([deck("a", { title: "a", artist: "bc" })], () => 0)));
});

test("an older shell is told apart from a real error", () => {
    assert.equal(isMissingFeature("not available in this build"), true);
    assert.equal(isMissingFeature(new Error("Not available in this build")), true);
    assert.equal(isMissingFeature("cannot open the remote port: address in use"), false);
    assert.equal(isMissingFeature(null), false);
    assert.equal(errorText(new Error("request 7 not found")), "request 7 not found");
    assert.equal(errorText("Error: invalid role 'x'"), "invalid role 'x'");
    assert.equal(errorText("x".repeat(500)).length, 200);
});

test("known shell errors are told apart from unknown ones", () => {
    assert.equal(errorKind("connected mode is off"), "off");
    assert.equal(errorKind("cannot open the remote port: Address already in use (os error 10048)"), "port");
    assert.equal(errorDetail("cannot open the remote port: Address already in use (os error 10048)"), "Address already in use (os error 10048)");
    assert.equal(errorKind("connected mode worker is not running"), "worker");
    assert.equal(errorKind("connected mode worker is not running: no threads"), "worker");
    assert.equal(errorKind("request 7 not found"), "notFound");
    assert.equal(errorKind("invalid bind address 'x'"), "bind");
    assert.equal(errorKind("bind to 0.0.0.0 or to one address, not to the IPv6 wildcard"), "bind");
    assert.equal(errorKind("invalid role 'x' (controller, viewer or guest)"), "role");
    assert.equal(errorKind("invalid status 'done' (accepted, rejected or played)"), "role");
    assert.equal(errorKind("something else entirely"), "unknown");
    assert.equal(errorKind(""), "unknown");
    assert.equal(errorDetail("plain"), null);
    assert.equal(errorDetail("x: "), null);
});

test("new pending requests: arrivals and re-opened ones, not the ones already waiting", () => {
    const p = (id: number, status: "pending" | "accepted" | "rejected" | "played" = "pending") => ({ id, status });
    assert.deepEqual(newPending([], [p(1), p(2)]), [p(1), p(2)]);
    assert.deepEqual(newPending([p(1)], [p(1), p(2)]), [p(2)]);
    assert.deepEqual(newPending([p(1), p(2)], [p(1), p(2)]), []);
    // A decision changes nothing; a reject undone (back to pending) is announced again.
    assert.deepEqual(newPending([p(1)], [p(1, "accepted")]), []);
    assert.deepEqual(newPending([p(1, "rejected")], [p(1)]), [p(1)]);
    // Order of the list is kept (the server sorts by votes).
    assert.deepEqual(newPending([p(2)], [p(3), p(2), p(1)]), [p(3), p(1)]);
});

test("focus after a decision stays on the row, or moves to the row that took its place", () => {
    const page = [{ id: 10 }, { id: 11 }, { id: 12 }];
    assert.equal(focusRowAfter(11, page, 1), 1, "still on the page");
    assert.equal(focusRowAfter(11, [{ id: 10 }, { id: 12 }], 1), 1, "the next row moved up into its place");
    assert.equal(focusRowAfter(12, [{ id: 10 }, { id: 11 }], 2), 1, "it was the last row: the new last one");
    assert.equal(focusRowAfter(10, [{ id: 11 }], 0), 0);
    assert.equal(focusRowAfter(10, [], 0), null, "nothing left on the page");
    assert.equal(focusRowAfter(10, page, -1), 0);
    assert.equal(focusRowAfter(99, page, 7), 2);
});

test("the address of a device without its port", () => {
    assert.equal(hostOf("192.168.100.26:51844"), "192.168.100.26");
    assert.equal(hostOf("[fe80::1]:51844"), "fe80::1");
    assert.equal(hostOf("somewhere"), "somewhere");
});

test("tabs: arrows rove with wrap, Home / End jump, other keys and modifier combos pass", () => {
    assert.equal(rovingTarget({ key: "ArrowRight" }, 0, 3), 1);
    assert.equal(rovingTarget({ key: "ArrowRight" }, 2, 3), 0, "wraps");
    assert.equal(rovingTarget({ key: "ArrowLeft" }, 0, 3), 2, "wraps");
    assert.equal(rovingTarget({ key: "ArrowLeft" }, 2, 3), 1);
    assert.equal(rovingTarget({ key: "Home" }, 2, 3), 0);
    assert.equal(rovingTarget({ key: "End" }, 0, 3), 2);
    assert.equal(rovingTarget({ key: "ArrowDown" }, 0, 3), null);
    assert.equal(rovingTarget({ key: "Enter" }, 0, 3), null);
    assert.equal(rovingTarget({ key: "ArrowRight", ctrlKey: true }, 0, 3), null);
    assert.equal(rovingTarget({ key: "ArrowRight", altKey: true }, 0, 3), null);
    assert.equal(rovingTarget({ key: "ArrowRight", metaKey: true }, 0, 3), null);
    assert.equal(rovingTarget({ key: "ArrowRight" }, 9, 3), 0, "an index out of range is clamped first");
    assert.equal(rovingTarget({ key: "ArrowRight" }, 0, 0), null);
});

test("pager: left / right turn the page and stop at the ends", () => {
    assert.equal(pagerTarget({ key: "ArrowRight" }, 0, 3), 1);
    assert.equal(pagerTarget({ key: "ArrowRight" }, 2, 3), 2, "stays on the last page");
    assert.equal(pagerTarget({ key: "ArrowLeft" }, 0, 3), 0, "stays on the first page");
    assert.equal(pagerTarget({ key: "ArrowLeft" }, 2, 3), 1);
    assert.equal(pagerTarget({ key: "ArrowDown" }, 1, 3), null);
    assert.equal(pagerTarget({ key: "ArrowRight", ctrlKey: true }, 1, 3), null);
    assert.equal(pagerTarget({ key: "ArrowRight" }, 0, 1), 0);
});

test("every bare arrow is the popover's to consume, or it reaches the crossfader shortcut", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) assert.equal(isBareArrow({ key }), true, key);
    assert.equal(isBareArrow({ key: "ArrowLeft", ctrlKey: true }), false);
    assert.equal(isBareArrow({ key: "ArrowLeft", altKey: true }), false);
    assert.equal(isBareArrow({ key: "ArrowLeft", metaKey: true }), false);
    assert.equal(isBareArrow({ key: "a" }), false);
    assert.equal(isBareArrow({ key: "Tab" }), false);
    // The contract with lib/shortcuts this guard exists for: an arrow on a button that did NOT
    // consume it is the global "crossfader hard to A / B / centre" shortcut ...
    const ev = (code: string, defaultPrevented: boolean) => ({ code, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented });
    assert.equal(matchShortcut(ev("ArrowRight", false), false, SHORTCUTS_BY_CODE)?.action, "crossfaderTo");
    assert.equal(matchShortcut(ev("ArrowLeft", false), false, SHORTCUTS_BY_CODE)?.action, "crossfaderTo");
    assert.equal(matchShortcut(ev("ArrowDown", false), false, SHORTCUTS_BY_CODE)?.action, "crossfaderCenter");
    // ... and one the popover consumed (preventDefault) is not.
    for (const code of ["ArrowLeft", "ArrowRight", "ArrowDown"]) assert.equal(matchShortcut(ev(code, true), false, SHORTCUTS_BY_CODE), null, code);
});

test("the popover guard consumes a bare arrow on a button and leaves fields and other keys alone", () => {
    const press = (key: string, target: unknown, patch: Record<string, unknown> = {}) => {
        const e = { key, target, defaultPrevented: false, prevented: 0, preventDefault() { this.prevented += 1; this.defaultPrevented = true; }, ...patch };
        return { consumed: consumeBareArrows(e), prevented: e.prevented };
    };
    const button = { tagName: "BUTTON" };
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) assert.deepEqual(press(key, button), { consumed: true, prevented: 1 }, key);
    assert.deepEqual(press("ArrowRight", { tagName: "DIV" }), { consumed: true, prevented: 1 });
    assert.deepEqual(press("ArrowRight", null), { consumed: true, prevented: 1 });
    // Already used by a control inside (the tablist, the pager): nothing more to do.
    assert.deepEqual(press("ArrowRight", button, { defaultPrevented: true }), { consumed: false, prevented: 0 });
    // Fields that edit with arrows keep them.
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) assert.deepEqual(press("ArrowLeft", { tagName }), { consumed: false, prevented: 0 }, tagName);
    assert.deepEqual(press("ArrowLeft", { tagName: "DIV", isContentEditable: true }), { consumed: false, prevented: 0 });
    // Not an arrow, or a modifier combo: passes.
    assert.deepEqual(press("Enter", button), { consumed: false, prevented: 0 });
    assert.deepEqual(press(" ", button), { consumed: false, prevented: 0 });
    assert.deepEqual(press("ArrowLeft", button, { altKey: true }), { consumed: false, prevented: 0 });
    assert.deepEqual(press("ArrowLeft", button, { ctrlKey: true }), { consumed: false, prevented: 0 });
});
