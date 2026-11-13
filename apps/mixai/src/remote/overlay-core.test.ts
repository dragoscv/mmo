// Run: node --test apps/mixai/src/remote/overlay-core.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { OVERLAY_STORE_KEY, REMOTE_DEFAULT_PORT, copyKey, copyText, isOverlayToken, loadOverlaySaved, onAirLine, overlaySavedJson, overlaySupported, parseOverlaySaved, rememberOverlay, savedAfter, startArgs, storeOverlaySaved, type ClipboardLike, type StorageLike } from "./overlay-core.ts";
import { remoteMessages } from "../i18n/messages-remote.ts";

const TOKEN = "00112233445566778899aabbccddeeff";
const OTHER = "ffeeddccbbaa99887766554433221100";
const URL_HERE = `http://127.0.0.1:${REMOTE_DEFAULT_PORT}/now?t=${TOKEN}`;

/** A clipboard that records what it was given; `refuse` makes it reject like a browser without permission. */
function clipboard(refuse = false): ClipboardLike & { written: string[] } {
    const written: string[] = [];
    return {
        written,
        writeText: async (text: string) => {
            if (refuse) throw new Error("NotAllowedError");
            written.push(text);
        },
    };
}

/** An in-memory storage; `broken` throws on every call like a disabled localStorage. */
function memory(broken = false): StorageLike & { data: Map<string, string>; writes: number } {
    const data = new Map<string, string>();
    const guard = () => {
        if (broken) throw new Error("SecurityError");
    };
    const st = {
        data,
        writes: 0,
        getItem: (k) => (guard(), data.get(k) ?? null),
        setItem: (k, v) => (guard(), st.writes++, void data.set(k, v)),
        removeItem: (k) => (guard(), st.writes++, void data.delete(k)),
    } as StorageLike & { data: Map<string, string>; writes: number };
    return st;
}

test("copy writes exactly the address and says what happened", async () => {
    const ok = clipboard();
    assert.equal(await copyText(URL_HERE, ok), "copied");
    assert.deepEqual(ok.written, [URL_HERE]);
    // A refusing clipboard, and no clipboard at all, are failures, never a throw.
    const no = clipboard(true);
    assert.equal(await copyText(URL_HERE, no), "failed");
    assert.deepEqual(no.written, []);
    assert.equal(await copyText(URL_HERE, null), "failed");
    // Nothing to copy: nothing is written.
    const idle = clipboard();
    for (const nothing of ["", null, undefined]) assert.equal(await copyText(nothing, idle), "empty");
    assert.deepEqual(idle.written, []);
});

test("each copy result has its own sentence, in both languages", () => {
    assert.equal(copyKey("copied"), "remote.overlay.copied");
    assert.equal(copyKey("failed"), "remote.overlay.copyFailed");
    assert.equal(copyKey("empty"), "remote.overlay.copyFailed");
    for (const lang of ["en", "ro"] as const) {
        const good = remoteMessages[lang][copyKey("copied")];
        const bad = remoteMessages[lang][copyKey("failed")];
        assert.notEqual(good, bad);
        assert.ok(good.length > 5 && bad.length > 5);
    }
    assert.notEqual(remoteMessages.en["remote.overlay.copied"], remoteMessages.ro["remote.overlay.copied"]);
});

test("only the exact form of a shell code is a code; the fixed port is a user port", () => {
    assert.ok(isOverlayToken(TOKEN));
    for (const bad of ["", TOKEN.slice(1), TOKEN + "0", TOKEN.toUpperCase(), TOKEN.replace("0", "g"), ` ${TOKEN.slice(1)}`, `${TOKEN.slice(0, 31)}\n`, null, undefined, 42, {}]) assert.ok(!isOverlayToken(bad), JSON.stringify(bad));
    assert.ok(Number.isInteger(REMOTE_DEFAULT_PORT) && REMOTE_DEFAULT_PORT >= 1024 && REMOTE_DEFAULT_PORT < 49152, "the default is a registered-range (user) port, below the dynamic range a fallback comes from");
});

test("only the code is stored; a value from before (with a port) still gives its code", () => {
    assert.deepEqual(parseOverlaySaved(JSON.stringify({ token: TOKEN })), { token: TOKEN });
    // What the previous build stored: the code is read, the port is not (nothing else may read it).
    for (const port of [47831, 61234, 80, "x", null]) assert.deepEqual(parseOverlaySaved(JSON.stringify({ port, token: TOKEN })), { token: TOKEN }, String(port));
    assert.deepEqual(parseOverlaySaved(JSON.stringify({ port: 61234, token: null })), { token: null });
    assert.deepEqual(parseOverlaySaved(JSON.stringify({ port: 50123, token: "<script>" })), { token: null });
    for (const raw of [null, undefined, "", "not json", "null", "42", '"x"', "[]", "{}"]) assert.deepEqual(parseOverlaySaved(raw), { token: null }, String(raw));
    // Round trip; the stored text holds the code and nothing else; nothing worth keeping = nothing stored.
    assert.equal(overlaySavedJson({ token: OTHER }), JSON.stringify({ token: OTHER }));
    assert.deepEqual(parseOverlaySaved(overlaySavedJson({ token: OTHER })), { token: OTHER });
    assert.equal(overlaySavedJson({ token: null }), null);
    assert.equal(overlaySavedJson({ token: "x" }), null);
});

test("storage keeps the code under its own key and never throws", () => {
    const st = memory();
    assert.deepEqual(loadOverlaySaved(st), { token: null });
    assert.ok(storeOverlaySaved(st, { token: TOKEN }));
    assert.deepEqual([...st.data.keys()], [OVERLAY_STORE_KEY]);
    assert.deepEqual(loadOverlaySaved(st), { token: TOKEN });
    assert.ok(!st.data.get(OVERLAY_STORE_KEY)!.includes("port"), "no port is stored");
    // Nothing left to keep removes the entry.
    assert.ok(storeOverlaySaved(st, { token: null }));
    assert.equal(st.data.size, 0);
    // A storage that throws, or none: reads as nothing, a write reports false.
    assert.deepEqual(loadOverlaySaved(memory(true)), { token: null });
    assert.equal(storeOverlaySaved(memory(true), { token: TOKEN }), false);
    assert.deepEqual(loadOverlaySaved(null), { token: null });
    assert.equal(storeOverlaySaved(null, { token: TOKEN }), false);
});

test("a shell is offered the overlay only when it reports portFallback", () => {
    assert.ok(overlaySupported({ portFallback: false }));
    assert.ok(overlaySupported({ portFallback: true }));
    // A shell built before the overlay: the field is absent.
    for (const old of [{}, null, undefined, { portFallback: undefined }]) assert.ok(!overlaySupported(old));
});

test("the code of a running server is kept, its port never; off or an old shell changes nothing", () => {
    const prev = { token: TOKEN };
    assert.deepEqual(savedAfter(prev, { running: true, port: REMOTE_DEFAULT_PORT, overlayToken: OTHER, portFallback: false }), { token: OTHER });
    // A fallback port is NOT kept: it is for this run only (the next start asks for the fixed
    // port again). Only the code is taken from that answer.
    assert.deepEqual(savedAfter(prev, { running: true, port: 61234, overlayToken: OTHER, portFallback: true }), { token: OTHER });
    assert.deepEqual(savedAfter(prev, { running: false, port: null, overlayToken: null, portFallback: false }), prev);
    // Off means off, whatever else the answer carries: nothing of a server that does not run is kept.
    assert.deepEqual(savedAfter(prev, { running: false, port: 61234, overlayToken: OTHER, portFallback: false }), prev);
    assert.deepEqual(savedAfter(prev, { running: true, port: 52000, overlayToken: OTHER }), prev, "an old shell reports no overlay: nothing is taken");
    // A malformed code in the answer keeps what was there.
    assert.deepEqual(savedAfter(prev, { running: true, port: 0, overlayToken: "nope", portFallback: false }), prev);
    assert.deepEqual(savedAfter({ token: null }, { running: true, port: REMOTE_DEFAULT_PORT, overlayToken: null, portFallback: false }), { token: null });
});

test("every start asks a new shell for the fixed port and the saved code, and an old shell for nothing new", () => {
    const none = { token: null };
    // First start ever: the default port, no code yet.
    assert.deepEqual(startArgs(undefined, none, true), { port: REMOTE_DEFAULT_PORT });
    // Later starts: the fixed port again (whatever the last run fell back to) and the saved code.
    assert.deepEqual(startArgs(undefined, { token: TOKEN }, true), { port: REMOTE_DEFAULT_PORT, overlayToken: TOKEN });
    // A value stored by the previous build, with its fallback port: the port is not asked for.
    assert.deepEqual(startArgs(undefined, parseOverlaySaved(JSON.stringify({ port: 61234, token: TOKEN })), true), { port: REMOTE_DEFAULT_PORT, overlayToken: TOKEN });
    // Even an object that still carries a port (a caller that did not go through the parser): ignored.
    assert.deepEqual(startArgs(undefined, { port: 61234, token: TOKEN } as { token: string }, true), { port: REMOTE_DEFAULT_PORT, overlayToken: TOKEN });
    // What the caller asks for wins over what was saved; the bind passes through.
    assert.deepEqual(startArgs({ bind: "127.0.0.1", port: 50000 }, { token: TOKEN }, true), { bind: "127.0.0.1", port: 50000, overlayToken: TOKEN });
    assert.deepEqual(startArgs({ bind: "127.0.0.1" }, none, true), { bind: "127.0.0.1", port: REMOTE_DEFAULT_PORT });
    // A stored value that is not a code is not sent.
    assert.deepEqual(startArgs(undefined, { token: "x" }, true), { port: REMOTE_DEFAULT_PORT });
    // An old shell: exactly what the caller gave, as before the overlay existed.
    assert.deepEqual(startArgs(undefined, { token: TOKEN }, false), {});
    assert.deepEqual(startArgs({ bind: "127.0.0.1" }, { token: TOKEN }, false), { bind: "127.0.0.1" });
    assert.deepEqual(startArgs({ bind: "127.0.0.1", port: 50000 }, none, false), { bind: "127.0.0.1", port: 50000 });
});

test("after a fallback the next start asks for the fixed port again (the address does not drift)", () => {
    // The whole loop the store runs: start -> status -> remember -> next start.
    const st = memory();
    const run = (port: number, fallback: boolean, token = TOKEN) => rememberOverlay(st, { running: true, port, overlayToken: token, portFallback: fallback });
    const next = () => startArgs(undefined, loadOverlaySaved(st), true);
    assert.deepEqual(next(), { port: REMOTE_DEFAULT_PORT });
    run(REMOTE_DEFAULT_PORT, false);
    assert.deepEqual(next(), { port: REMOTE_DEFAULT_PORT, overlayToken: TOKEN });
    // 47831 taken once: the shell ran on a dynamic port. The next start does not ask for that one.
    run(61234, true);
    assert.deepEqual(next(), { port: REMOTE_DEFAULT_PORT, overlayToken: TOKEN });
    run(52014, true);
    run(63377, true);
    assert.deepEqual(next(), { port: REMOTE_DEFAULT_PORT, overlayToken: TOKEN }, "however many fallbacks came before");
    assert.equal(st.data.get(OVERLAY_STORE_KEY), JSON.stringify({ token: TOKEN }));
});

test("remembering writes only on a change and rewrites a value from before once, without its port", () => {
    const st = memory();
    const status = { running: true, port: REMOTE_DEFAULT_PORT, overlayToken: TOKEN, portFallback: false };
    rememberOverlay(st, status);
    assert.equal(st.writes, 1);
    // The status comes back many times while Connect runs: no write for the same code.
    for (let i = 0; i < 5; i++) rememberOverlay(st, status);
    assert.equal(st.writes, 1);
    rememberOverlay(st, { ...status, overlayToken: OTHER });
    assert.equal(st.writes, 2);
    assert.equal(st.data.get(OVERLAY_STORE_KEY), JSON.stringify({ token: OTHER }));
    // Off, or an old shell: nothing is written.
    rememberOverlay(st, { running: false, port: null, overlayToken: null, portFallback: false });
    rememberOverlay(st, { running: true, port: 61234, overlayToken: TOKEN });
    assert.equal(st.writes, 2);
    // What the previous build stored (code + fallback port): one rewrite, the code kept, the port gone.
    const old = memory();
    old.data.set(OVERLAY_STORE_KEY, JSON.stringify({ port: 61234, token: TOKEN }));
    rememberOverlay(old, status);
    assert.equal(old.data.get(OVERLAY_STORE_KEY), JSON.stringify({ token: TOKEN }));
    rememberOverlay(old, status);
    assert.equal(old.writes, 1);
    // A value from before with no usable code, while off: left alone (nothing to keep, nothing to drop yet).
    const odd = memory();
    odd.data.set(OVERLAY_STORE_KEY, JSON.stringify({ port: 61234, token: null }));
    rememberOverlay(odd, { running: false, port: null, portFallback: false });
    assert.equal(odd.writes, 0);
    // A storage that throws: nothing happens, nothing throws.
    rememberOverlay(memory(true), status);
    rememberOverlay(null, status);
});

test("the on-air line never shows an empty part", () => {
    assert.equal(onAirLine({ title: "Strobe", artist: "deadmau5" }), "Strobe · deadmau5");
    assert.equal(onAirLine({ title: "Strobe", artist: null }), "Strobe");
    assert.equal(onAirLine({ title: null, artist: "deadmau5" }), "deadmau5");
    assert.equal(onAirLine({ title: "  Strobe ", artist: "   " }), "Strobe");
    for (const nothing of [null, undefined, {}, { title: null, artist: null }, { title: "", artist: "" }, { title: "  ", artist: undefined }]) assert.equal(onAirLine(nothing), null);
    // Values of the wrong type (a shell that changed) never print as "undefined" / "[object Object]".
    assert.equal(onAirLine({ title: 5 as unknown as string, artist: {} as unknown as string }), null);
});
