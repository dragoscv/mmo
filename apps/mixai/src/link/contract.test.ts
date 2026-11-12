// Run: node --test apps/mixai/src/link/contract.test.ts
//
// The contract between the tempo-sync UI and src-tauri/src/link.rs, checked against the Rust
// SOURCE (not a copy of it): the fields of the status, the parameters the commands declare, the
// event name, and every refusal text the UI turns into a sentence. A renamed field or a reworded
// refusal otherwise shows only at run time, in the native app, as a missing readout or as
// "Tempo sync did not accept the command".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linkMessages } from "../i18n/messages-link.ts";
import { LINK_OFF, errorKey, isUnavailable, type LinkErrorKey } from "./link-math.ts";

const rust = readFileSync(new URL("../../src-tauri/src/link.rs", import.meta.url), "utf8");
const lib = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
const bridgeSrc = readFileSync(new URL("../bridge/link.ts", import.meta.url), "utf8");
const chipSrc = readFileSync(new URL("./LinkChip.tsx", import.meta.url), "utf8");

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** `const NAME: &str = "text";` in link.rs. */
function rustConst(name: string): string {
    const m = new RegExp(`const ${name}: &str = "([^"]+)";`).exec(rust);
    assert.ok(m, `const ${name} not found in link.rs`);
    return m[1]!;
}

/** Split on commas that are not inside `<...>` (`State<'_, LinkCtl>` is one parameter). */
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

/** `#[tauri::command] pub [async] fn name(params)` → the parameters the webview sends (camelCase). */
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

test("the status the shell serialises is the status the UI reads, field by field", () => {
    const m = /((?:#\[[^\]]*\]\s*)*)pub struct LinkStatus \{([^}]*)\}/.exec(rust);
    assert.ok(m, "struct LinkStatus not found in link.rs");
    assert.match(m[1]!, /rename_all = "camelCase"/, "LinkStatus must serialise as camelCase");
    const rustFields = [...m[2]!.matchAll(/^\s*pub (\w+):/gm)].map((f) => camel(f[1]!)).sort();
    assert.ok(rustFields.length >= 15, `only ${rustFields.length} fields parsed`);
    // LINK_OFF is typed as the bridge's LinkStatus: its keys are the interface's fields.
    assert.deepEqual(rustFields, Object.keys(LINK_OFF).sort());
    const ts = /export interface LinkStatus \{([^}]*)\}/.exec(bridgeSrc);
    assert.ok(ts, "interface LinkStatus not found in bridge/link.ts");
    const tsFields = [...ts[1]!.matchAll(/^\s*(\w+)\??:/gm)].map((f) => f[1]!).sort();
    assert.deepEqual(tsFields, rustFields);
    assert.ok(rustFields.includes("tempoLocked"));
});

test("every command exists, is registered, and gets exactly the parameters it declares", () => {
    const commands = rustCommands();
    assert.deepEqual([...commands.keys()].sort(), ["link_set", "link_start", "link_status", "link_stop"]);
    for (const name of commands.keys()) assert.match(lib, new RegExp(`link::${name}\\b`), `${name} is not registered in lib.rs`);
    // What bridge/link.ts sends: `call<...>("name", { a: ..., b: ... })` or `call<...>("name")`.
    for (const [name, params] of commands) {
        const call = new RegExp(`call<LinkStatus>\\("${name}"(?:,\\s*\\{([^}]*)\\})?\\)`).exec(bridgeSrc);
        assert.ok(call, `bridge/link.ts never calls ${name}`);
        const sent = (call[1] ?? "")
            .split(",")
            .map((p) => p.slice(0, p.indexOf(":")).trim())
            .filter((p) => p.length > 0)
            .sort();
        assert.deepEqual(sent, [...params].sort(), `${name}: sent ${sent.join(", ")} / declared ${params.join(", ")}`);
    }
    assert.deepEqual(commands.get("link_set"), ["bpm", "nudgeBeats"]);
    assert.deepEqual(commands.get("link_start"), ["pin", "bind", "port"]);
});

test("the event name is the one the shell emits", () => {
    const event = /const EVENT: &str = "([^"]+)";/.exec(rust);
    assert.ok(event);
    assert.equal(event[1], "link://state");
    assert.ok(bridgeSrc.includes(`listen<unknown>("${event[1]}"`), "bridge/link.ts listens to another event");
});

test("every refusal of the shell maps to its own sentence, in both languages", () => {
    const wanted: Array<[string, LinkErrorKey]> = [
        [rustConst("ERR_TEMPO_LOCKED"), "link.err.tempoLocked"],
        [rustConst("ERR_NUDGE_LEADER"), "link.err.nudgeLeader"],
        [rustConst("ERR_NOT_RUNNING"), "link.err.generic"],
    ];
    for (const [text, key] of wanted) {
        assert.equal(errorKey(text), key, text);
        assert.ok(!isUnavailable(text), `"${text}" must not read as "no tempo sync in this build"`);
    }
    // The refusals written in place (format strings and `.to_string()` literals).
    const literals = [...rust.matchAll(/"((?:pin|bind|port|bpm|nudge) must be[^"]*)"/g)].map((m) => m[1]!);
    assert.ok(literals.length >= 5, `only ${literals.length} argument refusals found in link.rs`);
    for (const text of literals) assert.notEqual(errorKey(text), "link.err.tempoLocked", text);
    assert.equal(errorKey(literals.find((l) => l.startsWith("pin"))!), "link.err.pin");
    assert.equal(errorKey(literals.find((l) => l.startsWith("bpm"))!), "link.err.bpm");
    assert.match(rust, /format!\("could not start tempo sync: \{e\}"\)/);
    assert.equal(errorKey("could not start tempo sync: os error 10048"), "link.err.start");
    // Each key the UI can show has a sentence in EN and RO, and the two differ (a copied
    // English sentence in the Romanian table would pass the parity test).
    for (const key of ["link.err.tempoLocked", "link.err.nudgeLeader", "link.tempoLocked.leader", "link.tempoLocked.follow", "link.pinOn", "link.pinHint"] as const) {
        assert.ok(linkMessages.en[key].length > 10, key);
        assert.ok(linkMessages.ro[key].length > 10, key);
        assert.notEqual(linkMessages.en[key], linkMessages.ro[key], key);
    }
});

test("the PIN is described as a grouping code, never as access control", () => {
    for (const lang of ["en", "ro"] as const) {
        for (const key of ["link.pinHint", "link.pinOn"] as const) {
            const text = linkMessages[lang][key];
            assert.doesNotMatch(text, /\bonly\b|\bdoar\b|secure|protect|sigur|protej/i, `${lang} ${key}: "${text}"`);
        }
    }
    assert.match(linkMessages.en["link.pinOn"], /not a password/i);
    assert.match(linkMessages.ro["link.pinOn"], /nu parolă/i);
});

test("the popover never switches a focusable control off with the native disabled", () => {
    // `disabled` on the element that holds the focus sends the focus to <body>. Fields are
    // read-only, buttons aria-disabled (see the header of LinkChip.tsx).
    const code = chipSrc.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert.doesNotMatch(code, /\sdisabled=\{/, "a native disabled attribute is back in LinkChip.tsx");
    assert.match(code, /readOnly=\{running \|\| busy\}/);
    assert.match(code, /aria-disabled=\{leader \|\| undefined\}/);
    // While sync runs the chip is not a part the status-bar fit may hide.
    assert.match(code, /data-prio=\{running \? undefined : PRIO_CHIP_OFF\}/);
});

test("bare arrows pressed in the popover never reach the crossfader shortcuts", () => {
    // The app binds bare arrows globally to the crossfader (lib/shortcuts.ts): a popover must
    // consume the ones nothing inside used, like the remote, practice and co-pilot popovers.
    const code = chipSrc.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert.match(code, /import \{ consumeBareArrows \} from "@\/remote\/remote-core";/);
    assert.match(code, /<PopoverContent[^>]*onKeyDown=\{\(e\) => \{\s*consumeBareArrows\(e\);\s*\}\}/);
});
