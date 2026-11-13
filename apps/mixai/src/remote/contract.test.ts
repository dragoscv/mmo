// Run: node --test apps/mixai/src/remote/contract.test.ts
//
// The contract between the Connect UI and src-tauri/src/remote.rs, checked against the Rust
// SOURCE (not a copy of it): the commands and the parameters they declare, every field of the
// status / event / device / pairing / on-air structs that crosses the bridge, the event names
// and the refusal texts the UI turns into sentences. A renamed field otherwise shows only at
// run time, in the native app, as a missing address or an overlay tab that never appears.
// Also pinned here: the fixed port is the documented one, and the saved overlay code stays out
// of the settings export and the cloud profile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OVERLAY_STORE_KEY, REMOTE_DEFAULT_PORT, overlaySupported } from "./overlay-core.ts";
import { errorKind, type ErrorKind } from "./remote-core.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const rust = read("../../src-tauri/src/remote.rs");
const lib = read("../../src-tauri/src/lib.rs");
const bridgeSrc = read("../bridge/remote.ts");
const storeSrc = read("./remote-store.ts");
const docs = read("../../../../docs/decks/remote.md");

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Split on commas that are not inside `<...>` (`State<'_, RemoteCtl>` is one parameter). */
function splitParams(list: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of list) {
        if (ch === "<") depth++;
        else if (ch === ">") depth--;
        if (ch === "," && depth === 0) {
            out.push(cur);
            cur = "";
        } else cur += ch;
    }
    out.push(cur);
    return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** `#[tauri::command] pub fn name(params)` → the parameters the webview sends (camelCase). */
function rustCommands(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const m of rust.matchAll(/#\[tauri::command\]\s*pub (?:async )?fn (\w+)\(([^)]*)\)/g)) {
        const params = splitParams(m[2]!)
            .map((p) => ({ name: p.slice(0, p.indexOf(":")).trim(), type: p.slice(p.indexOf(":") + 1).trim() }))
            // Injected by Tauri, never sent by the webview.
            .filter((p) => !/^(State<|tauri::AppHandle|tauri::Window)/.test(p.type))
            .map((p) => camel(p.name));
        out.set(m[1]!, params);
    }
    return out;
}

/**
 * Fields of `struct Name { ... }` in remote.rs as the webview sees them (the struct must serialise
 * camelCase). LIMIT: the body is taken up to the FIRST `}`, so it works for structs whose fields
 * hold no braces (true for all five today: attributes and generics such as `Option<Vec<T>>` have
 * none). A field with a brace inside its declaration (an inline struct, a `{` in a doc comment)
 * would cut the list short; the `fields.length > 0` check and the expected lists below then fail
 * loudly rather than pass on a partial list.
 */
function rustFields(name: string): string[] {
    const m = new RegExp(`((?:#\\[[^\\]]*\\]\\s*)*)(?:pub )?struct ${name} \\{([^}]*)\\}`).exec(rust);
    assert.ok(m, `struct ${name} not found in remote.rs`);
    assert.match(m[1]!, /rename_all = "camelCase"/, `${name} must serialise as camelCase`);
    const fields = [...m[2]!.matchAll(/^\s*(?:pub )?(\w+):/gm)].map((f) => camel(f[1]!));
    assert.ok(fields.length > 0, `no fields parsed in ${name}`);
    return fields.sort();
}

/** Fields of `export interface Name { ... }` in bridge/remote.ts, and the optional ones among them. */
function tsFields(name: string): { all: string[]; optional: string[] } {
    const m = new RegExp(`export interface ${name} \\{([^}]*)\\}`).exec(bridgeSrc);
    assert.ok(m, `interface ${name} not found in bridge/remote.ts`);
    const found = [...m[1]!.matchAll(/^\s*(\w+)(\??):/gm)];
    assert.ok(found.length > 0, `no fields parsed in ${name}`);
    return { all: found.map((f) => f[1]!).sort(), optional: found.filter((f) => f[2] === "?").map((f) => f[1]!).sort() };
}

/** Property names of the object literal a bridge call sends: `call<T>("name", { a: x, b })`. */
function sentBy(command: string): string[] {
    const call = new RegExp(`call<[^>]+>\\("${command}"(?:,\\s*\\{([^}]*)\\})?\\)`).exec(bridgeSrc);
    assert.ok(call, `bridge/remote.ts never calls ${command}`);
    return (call[1] ?? "")
        .split(",")
        .map((p) => (p.includes(":") ? p.slice(0, p.indexOf(":")) : p).trim())
        .filter((p) => p.length > 0)
        .sort();
}

/** `const NAME: &str = "text";` in remote.rs. */
function rustConst(name: string): string {
    const m = new RegExp(`const ${name}: &str = "([^"]+)";`).exec(rust);
    assert.ok(m, `const ${name} not found in remote.rs`);
    return m[1]!;
}

const COMMANDS = ["remote_request_set", "remote_requests", "remote_rotate", "remote_set", "remote_start", "remote_status", "remote_stop"];

test("every command exists, is registered, and gets exactly the parameters it declares", () => {
    const commands = rustCommands();
    assert.deepEqual([...commands.keys()].sort(), COMMANDS);
    for (const name of COMMANDS) assert.match(lib, new RegExp(`remote::${name}\\b`), `${name} is not registered in lib.rs`);
    for (const [name, params] of commands) assert.deepEqual(sentBy(name), [...params].sort(), `${name}: the bridge sends ${sentBy(name).join(", ")} / the shell declares ${params.join(", ")}`);
    // The three commands the stream overlay rides on, argument by argument and in order.
    assert.deepEqual(commands.get("remote_start"), ["partyOpen", "port", "bind", "overlayToken"]);
    assert.deepEqual(commands.get("remote_set"), ["partyOpen", "labels", "clearDone", "controlsLocked", "overlayRotate"]);
    assert.deepEqual(commands.get("remote_rotate"), ["role"]);
    assert.deepEqual(commands.get("remote_request_set"), ["id", "status"]);
    for (const none of ["remote_status", "remote_stop", "remote_requests"]) assert.deepEqual(commands.get(none), [], none);
});

test("the status the shell serialises is the status the UI reads, field by field", () => {
    const shell = rustFields("RemoteStatus");
    const ui = tsFields("RemoteStatus");
    assert.deepEqual(ui.all, shell);
    assert.deepEqual(shell, ["clients", "controlsLocked", "host", "onAir", "overlayToken", "pairings", "partyOpen", "port", "portFallback", "requestsPending", "running", "urlController", "urlGuest", "urlOverlay", "urlOverlayLan", "urlViewer"]);
    // Fields a shell built before them does not send are optional in the UI's type: the UI
    // must cope with their absence (R8: the popover works as before with an old shell).
    assert.deepEqual(ui.optional, ["controlsLocked", "onAir", "overlayToken", "portFallback", "urlOverlay", "urlOverlayLan"]);
    // `portFallback` is how the UI tells a shell that knows the overlay: the shell must send it
    // as a plain bool (present while off too), never an Option that could be absent.
    assert.match(rust, /pub port_fallback: bool,/);
    assert.ok(overlaySupported({ portFallback: false }) && !overlaySupported({}));
});

test("the event, the device, the pairing and the on-air track match field by field", () => {
    const pairs: Array<[string, string, string[]]> = [
        ["RemoteEvent", "RemoteEvent", ["clients", "controlsLocked", "onAir", "partyOpen", "requests", "running"]],
        ["ClientView", "RemoteClient", ["addr", "id", "overlay", "role"]],
        ["Pairing", "RemotePairing", ["qrSvg", "role", "url"]],
        ["OnAirView", "RemoteOnAir", ["artist", "title"]],
        ["CuePayload", "RemoteCueEvent", ["deck", "sec"]],
    ];
    for (const [rustName, tsName, expected] of pairs) {
        const shell = rustFields(rustName);
        assert.deepEqual(shell, expected, rustName);
        assert.deepEqual(tsFields(tsName).all, shell, `${tsName} (UI) / ${rustName} (shell)`);
    }
    // What the store reads off those payloads really is one of their fields.
    for (const used of ["s.urlOverlay", "s.urlOverlayLan", "s.portFallback", "s.onAir", "e.onAir", "e.clients", "e.requests"]) assert.ok(storeSrc.includes(used), `remote-store.ts no longer reads ${used}`);
});

test("the event names are the ones the shell emits", () => {
    const state = rustConst("STATE_EVENT");
    const cue = rustConst("CUE_EVENT");
    assert.equal(state, "remote://state");
    assert.equal(cue, "remote://cue");
    assert.ok(bridgeSrc.includes(`listen<RemoteEvent>("${state}"`), "bridge/remote.ts listens to another state event");
    assert.ok(bridgeSrc.includes(`listen<RemoteCueEvent>("${cue}"`), "bridge/remote.ts listens to another cue event");
});

test("every refusal of the shell is recognised by the UI", () => {
    const wanted: Array<[string, ErrorKind]> = [
        [rustConst("NOT_RUNNING"), "off"],
        [rustConst("NO_PUMP"), "worker"],
        [`${rustConst("NO_PORT")}: os error 10048`, "port"],
    ];
    for (const [text, kind] of wanted) assert.equal(errorKind(text), kind, text);
    // The refusals written in place.
    const literals = [...rust.matchAll(/format!\(\s*"((?:invalid|request)[^"]*)"/g)].map((m) => m[1]!);
    assert.ok(literals.length >= 4, `only ${literals.length} format refusals found in remote.rs`);
    for (const text of literals) assert.notEqual(errorKind(text.replace(/\{\w*\}/g, "7")), "unknown", text);
});

test("the fixed port is a user port, the documented one, and only the UI chooses it", () => {
    assert.equal(REMOTE_DEFAULT_PORT, 47831);
    assert.ok(docs.includes(String(REMOTE_DEFAULT_PORT)), "docs/decks/remote.md does not name the fixed port");
    // The shell takes the port as an argument (default 0 = any free port) and holds no copy of
    // the number that could drift from this one.
    assert.match(rust, /port\.unwrap_or\(0\)/);
    assert.ok(!rust.replace(/#\[cfg\(test\)\]\s*mod tests[\s\S]*$/, "").includes(String(REMOTE_DEFAULT_PORT)), "remote.rs hard-codes the port outside its tests");
    // The store sends the port and the saved code through `startArgs`, nothing hand-rolled.
    assert.match(storeSrc, /startArgs\(opts, loadOverlaySaved\(storage\(\)\), get\(\)\.overlaySupported\)/);
    // And it keeps no port between starts: what it stores goes through `rememberOverlay`, and
    // the stored type has no port field (a fallback port would be asked for again otherwise).
    const core = read("./overlay-core.ts");
    const saved = /export interface OverlaySaved \{([^}]*)\}/.exec(core);
    assert.ok(saved, "OverlaySaved not found in overlay-core.ts");
    assert.deepEqual([...saved[1]!.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]), ["token"]);
    assert.match(storeSrc, /rememberOverlay\(storage\(\), s\)/);
});

test("the saved overlay code is not part of the settings export nor of the cloud profile", () => {
    assert.equal(OVERLAY_STORE_KEY, "mixai-remote-overlay");
    // The two writers of a profile (and the module that gathers the live settings) neither read
    // this storage key nor reach the remote store: the code never leaves this computer.
    for (const file of ["../settings/settings-io.ts", "../settings/settings-live.ts", "../lib/cloud-sync.ts"]) {
        const src = read(file);
        assert.ok(src.length > 500, `${file} is empty?`);
        for (const leak of [OVERLAY_STORE_KEY, "overlay-core", "remote-store", "useRemoteStore", "overlayToken"]) assert.ok(!src.includes(leak), `${file} mentions ${leak}`);
    }
    // And the store persists it nowhere else: one key, through the two helpers.
    assert.ok(!storeSrc.includes("persist("), "remote-store.ts uses zustand persist");
    assert.deepEqual([...storeSrc.matchAll(/\b(?:localStorage|sessionStorage)\.(\w+)/g)].map((m) => m[1]), []);
    assert.match(storeSrc, /rememberOverlay\(storage\(\), s\)/);
});
