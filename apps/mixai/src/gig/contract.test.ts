// Run: cd apps/mixai; node --test src/gig/contract.test.ts
//
// Source contracts of the gig lock, checked against the files themselves (never a copy):
//   1. bridge/gig.ts <-> src-tauri/src/gig.rs: command names, the arguments each command
//      declares, the fields of every struct that crosses the bridge, the event name, and the
//      registration in lib.rs. A renamed field otherwise shows only at run time, in the native
//      app, as a row that reads "not available".
//   2. Every gate point of the app asks the one gate (`gigAllows` / `gigGate`): a gate removed
//      later turns this red.
//   3. The lock is not part of the settings file, of a settings profile or of the cloud profile.
//   4. The recording format the disk check assumes is the one the recorder writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GIG_ACTIONS, GIG_KEY, REC_BYTES_PER_SAMPLE, REC_CHANNELS, parseShell, parseSystem } from "./gig-core.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** Source without comments (a gate that is only mentioned in a comment is not a gate). */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const rust = read("../../src-tauri/src/gig.rs");
const lib = read("../../src-tauri/src/lib.rs");
const bridgeSrc = read("../bridge/gig.ts");

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Split on commas that are not inside `<...>` (`State<'_, GigCtl>` is one parameter). */
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

/** `#[tauri::command] pub [async] fn name(params)` -> the parameters the webview sends (camelCase). */
function rustCommands(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const m of rust.matchAll(/#\[tauri::command\]\s*pub (?:async )?fn (\w+)\(([^)]*)\)/g)) {
        const params = splitParams(m[2]!)
            .map((p) => ({ name: p.slice(0, p.indexOf(":")).trim(), type: p.slice(p.indexOf(":") + 1).trim() }))
            // Injected by Tauri, never sent by the webview.
            .filter((p) => !/^(State<|tauri::AppHandle|tauri::WebviewWindow|tauri::Window)/.test(p.type))
            .map((p) => camel(p.name));
        out.set(m[1]!, params);
    }
    return out;
}

/** Serialised field names of `pub struct Name { ... }` in gig.rs (must be `rename_all = "camelCase"`). */
function rustFields(name: string): string[] {
    const m = new RegExp(`((?:\\s*(?:///[^\\n]*|#\\[[^\\]]*\\]|//[^\\n]*)\\n)*)\\s*pub struct ${name} \\{([^}]*)\\}`).exec(rust);
    assert.ok(m, `struct ${name} not found in gig.rs`);
    assert.match(m[1]!, /rename_all = "camelCase"/, `${name} must serialise as camelCase`);
    return [...m[2]!.matchAll(/^\s*pub (\w+):/gm)].map((f) => camel(f[1]!)).sort();
}

/** Serialised variant names of `pub enum Name { ... }` in gig.rs. */
function rustVariants(name: string): string[] {
    const m = new RegExp(`((?:\\s*(?:///[^\\n]*|#\\[[^\\]]*\\]|//[^\\n]*)\\n)*)\\s*pub enum ${name} \\{([^}]*)\\}`).exec(rust);
    assert.ok(m, `enum ${name} not found in gig.rs`);
    assert.match(m[1]!, /rename_all = "camelCase"/, `${name} must serialise as camelCase`);
    return [...m[2]!.matchAll(/^\s*([A-Z]\w*),/gm)].map((v) => v[1]![0]!.toLowerCase() + v[1]!.slice(1)).sort();
}

/** Field names of `export interface Name { ... }` in bridge/gig.ts. */
function tsFields(name: string): string[] {
    const m = new RegExp(`export interface ${name} \\{([^}]*)\\}`).exec(bridgeSrc);
    assert.ok(m, `interface ${name} not found in bridge/gig.ts`);
    return [...m[1]!.matchAll(/^\s*(\w+)\??:/gm)].map((f) => f[1]!).sort();
}

/** The string union of field `field` of interface `name` in bridge/gig.ts. */
function tsUnion(name: string, field: string): string[] {
    const m = new RegExp(`export interface ${name} \\{([^}]*)\\}`).exec(bridgeSrc);
    assert.ok(m);
    const f = new RegExp(`^\\s*${field}: ([^;]+);`, "m").exec(m[1]!);
    assert.ok(f, `${name}.${field} not found`);
    return [...f[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!).sort();
}

// ─── 1. the bridge ───────────────────────────────────────────────────────────

test("every struct that crosses the bridge has the same fields on both sides", () => {
    // Written out: the fields the UI reads. A field added on one side only fails below.
    const want: Record<string, string[]> = {
        GigShell: ["keepAwake", "locked"],
        PowerStatus: ["charging", "percent", "source"],
        DiskStatus: ["error", "freeBytes", "network", "path", "totalBytes"],
        GigSystemStatus: ["disk", "power"],
    };
    for (const [name, fields] of Object.entries(want)) {
        assert.deepEqual(rustFields(name), fields, `gig.rs ${name}`);
        assert.deepEqual(tsFields(name), fields, `bridge/gig.ts ${name}`);
    }
    assert.deepEqual(rustVariants("KeepAwake"), ["failed", "off", "on", "unsupported"]);
    assert.deepEqual(tsUnion("GigShell", "keepAwake"), rustVariants("KeepAwake"));
    assert.deepEqual(rustVariants("PowerSource"), ["battery", "mains", "unknown"]);
    assert.deepEqual(tsUnion("PowerStatus", "source"), rustVariants("PowerSource"));
});

test("the guards of the UI accept exactly what the shell serialises", () => {
    // Built from the Rust field lists, so a renamed field makes the guard refuse the answer here.
    const shell = Object.fromEntries(rustFields("GigShell").map((f) => [f, f === "locked" ? true : "on"]));
    assert.deepEqual(parseShell(shell), { locked: true, keepAwake: "on" });
    for (const v of rustVariants("KeepAwake")) assert.equal(parseShell({ locked: false, keepAwake: v })?.keepAwake, v);
    const power = Object.fromEntries(rustFields("PowerStatus").map((f) => [f, f === "source" ? "battery" : f === "percent" ? 55 : false]));
    const disk = Object.fromEntries(rustFields("DiskStatus").map((f) => [f, f === "path" ? "C:\\sets" : f === "network" ? false : f === "error" ? null : 1000]));
    const sys = Object.fromEntries(rustFields("GigSystemStatus").map((f) => [f, f === "power" ? power : disk]));
    assert.deepEqual(parseSystem(sys), {
        power: { source: "battery", percent: 55, charging: false },
        disk: { path: "C:\\sets", freeBytes: 1000, totalBytes: 1000, network: false, error: null },
    });
    for (const v of rustVariants("PowerSource")) assert.equal(parseSystem({ power: { source: v, percent: null, charging: null }, disk })?.power.source, v);
});

test("every command exists, is registered, and gets exactly the parameters it declares", () => {
    const commands = rustCommands();
    assert.deepEqual([...commands.keys()].sort(), ["gig_close_seen", "gig_close_window", "gig_set_locked", "gig_status", "gig_system_status"]);
    // Registered under the module's own comment line, with its state and its init.
    const block = /\/\/ -- gig lock \(WP19-60\): commands of src\/gig\.rs --\n((?:\s*gig::\w+,\n)+)/.exec(lib);
    assert.ok(block, "the gig block of generate_handler! is missing in lib.rs");
    assert.deepEqual([...block[1]!.matchAll(/gig::(\w+),/g)].map((m) => m[1]!).sort(), [...commands.keys()].sort());
    assert.match(lib, /\nmod gig;\n/);
    assert.match(lib, /\.manage\(gig::GigCtl::default\(\)\)/);
    assert.match(lib, /gig::init\(&handle\);/);
    // What bridge/gig.ts sends: `call<...>("name", { a, b })`, `call<...>("name", { a: ... })` or `call<...>("name")`.
    for (const [name, params] of commands) {
        const call = new RegExp(`call<[^>]+>\\("${name}"(?:,\\s*\\{([^}]*)\\})?\\)`).exec(bridgeSrc);
        assert.ok(call, `bridge/gig.ts never calls ${name}`);
        const sent = (call[1] ?? "")
            .split(",")
            .map((p) => (p.includes(":") ? p.slice(0, p.indexOf(":")) : p).trim())
            .filter((p) => p.length > 0)
            .sort();
        assert.deepEqual(sent, [...params].sort(), `${name}: sent ${sent.join(", ") || "nothing"} / declared ${params.join(", ") || "nothing"}`);
    }
    assert.deepEqual(commands.get("gig_set_locked"), ["locked"]);
    assert.deepEqual(commands.get("gig_system_status"), ["path"]);
    assert.deepEqual(commands.get("gig_status"), []);
    // No command of the bridge is missing from the shell.
    for (const m of bridgeSrc.matchAll(/call<[^>]+>\("(\w+)"/g)) assert.ok(commands.has(m[1]!), `bridge/gig.ts calls ${m[1]}, which gig.rs does not have`);
});

test("the close request: one event name on both sides, and no Tauri close listener in the webview", () => {
    const event = /const CLOSE_EVENT: &str = "([^"]+)";/.exec(rust);
    assert.ok(event);
    assert.equal(event[1], "gig://close-request");
    assert.ok(bridgeSrc.includes(`listen<unknown>("${event[1]}"`), "bridge/gig.ts listens to another event");
    // A webview listener on Tauri's own close-requested event outlives a page reload inside
    // Tauri and would then refuse every close: the shell decides instead (see gig.rs).
    for (const rel of ["../bridge/gig.ts", "../bridge/window.ts", "./gig-runtime.ts", "./GigCloseDialog.tsx", "../App.tsx"]) {
        const code = strip(read(rel));
        assert.doesNotMatch(code, /onCloseRequested|tauri:\/\/close-requested|CLOSE_REQUESTED/, rel);
    }
    // So the capability needs nothing new: app commands are allowed, the window is closed by the shell.
    const cap = JSON.parse(read("../../src-tauri/capabilities/main.json")) as { windows: string[]; permissions: string[] };
    assert.deepEqual(cap.windows, ["main", "popout-*"]);
    assert.ok(cap.permissions.includes("core:event:default"), "the webview must be able to listen to the shell's event");
    assert.ok(!cap.permissions.includes("core:window:allow-destroy"), "the webview does not destroy windows itself; gig_close_window does");
    // The shell holds only the main window, and lets go when the page does not answer.
    assert.match(rust, /const MAIN_WINDOW: &str = "main";/);
    assert.match(rust, /const CLOSE_PATIENCE: Duration = Duration::from_millis\((\d+)\);/);
    const patience = Number(/CLOSE_PATIENCE: Duration = Duration::from_millis\((\d+)\)/.exec(rust)![1]);
    assert.ok(patience >= 500 && patience <= 5000, `a dead page holds the window for ${patience} ms`);
    // The webview acknowledges the question and can close for real.
    const runtime = strip(read("./gig-runtime.ts"));
    assert.match(runtime, /setCloseAsk\(true\);\s*void gig\.closeSeen\(\)/);
    // "Close anyway" asks the ENGINE whether a recording runs (the page's own flag is not
    // re-read after a page reload), stops it through the engine, and closes only after that
    // call returned: the WAV is complete before the process goes away.
    assert.match(runtime, /isRecording: \(\) => engine\.isRecording\(\)/);
    assert.match(runtime, /void engine\.stopRecording\(\)|await engine\.stopRecording\(\)/);
    assert.match(runtime, /closeWindow: \(\) => gig\.closeWindow\(\)/);
    assert.doesNotMatch(runtime, /\.toggle\(\)/, "the stop must not go through the store's toggle");
    const dialog = strip(read("./GigCloseDialog.tsx"));
    assert.doesNotMatch(dialog, /useRecordingStore/, "the dialog's text and its decision come from the engine, not the page");
    assert.match(dialog, /engineRecording\(\)/);
    assert.match(dialog, /closeForReal\(\)/);
});

test("keep-awake is a power request of the process, released on unlock and on drop", () => {
    const code = rust.replace(/\/\/[^\n]*/g, "");
    assert.match(code, /PowerCreateRequest\(&context\)/);
    assert.match(code, /PowerSetRequest\(handle, PowerRequestDisplayRequired\)/);
    assert.match(code, /PowerSetRequest\(handle, PowerRequestSystemRequired\)/);
    assert.doesNotMatch(code, /SetThreadExecutionState/, "a per-thread request ends with its thread");
    // Unlock releases.
    assert.match(code, /\} else \{\s*self\.wake\.release\(\);/);
    assert.match(code, /impl Drop for WakeLock \{\s*fn drop\(&mut self\) \{\s*self\.release\(\);/);
    // The frontend asks again after every page load and at every change of the lock.
    const runtime = strip(read("./gig-runtime.ts"));
    assert.match(runtime, /export function startGig\(\): \(\) => void \{\s*let stopped = false;\s*void syncShell\(\);/);
    assert.match(runtime, /if \(s\.locked === prev\.locked\) return;\s*void syncShell\(\);/);
    // The retry (bounded) and "the newest state is what the shell is told" are `runShellSync`
    // in gig-core, where they are tested; the runtime only wires it to the bridge.
    assert.match(runtime, /const link = await runShellSync\(\{/);
    assert.match(runtime, /setLocked: \(locked\) => gig\.setLocked\(locked\)/);
    assert.match(runtime, /useGigStore\.getState\(\)\.setAwake\(link\)/, "the shell's answer is shown in the popover");
    assert.match(strip(read("../App.tsx")), /useEffect\(\(\) => startGig\(\), \[\]\);/);
});

// ─── 2. every gate asks the one gate ─────────────────────────────────────────

test("every gate point calls the gate, with its own action", () => {
    const gates: [string, RegExp[]][] = [
        // Settings: both ways into the modal, in the one store every entry point uses.
        ["../state/ui-store.ts", [/setSettingsOpen: \(settingsOpen\) => \{\s*if \(settingsOpen && !gigAllows\("openSettings"\)\) return;/, /openSettings: \(tab\) => \{\s*if \(!gigAllows\("openSettings"\)\) return;/]],
        ["../settings/hotkey.ts", [/if \(!gigAllows\("openSettings"\)\) return;\s*useSettingsSearchFocus\.getState\(\)\.request\(\);/]],
        // Import, reset, profile switch and undo all end in applySections.
        ["../settings/settings-live.ts", [/export async function applySections\(sections: Sections\): Promise<ApplyOutcome> \{\s*if \(!gigAllows\("applySettings"\)\) return "locked";/, /export async function apply\(sections: Sections\): Promise<void> \{\s*await applySections\(sections\);/]],
        ["../settings/ProfileSwitcher.tsx", [/if \(!p\) return;\s*if \(!gigAllows\("switchProfile"\)\) return;/]],
        [
            "../lib/cloud-sync.ts",
            [
                // The two writers of the profile: the manual path and the MIDI-only path.
                /export async function applyProfile\(raw: string, opts: \{ includeCompanion\?: boolean \} = \{\}\): Promise<ApplyResult> \{\s*if \(!gigAllows\("applySettings"\)\) return "locked";/,
                /export async function applyProfileEngineOnly\(raw: string\): Promise<ApplyResult> \{\s*if \(!gigAllows\("applySettings"\)\) return "locked";/,
                // The automatic sync asks the gate through the machine (gig/held-sync.ts).
                /allowsPull: \(\) => gigAllows\("cloudPull"\)/,
                /allowsPush: \(\) => gigAllows\("cloudPush"\)/,
                // The lock's release runs what it held back.
                /if \(!prev\.locked && s\.locked\) void sync\.lockedNow\(\);/,
                /if \(prev\.locked && !s\.locked\) void sync\.released\(/,
            ],
        ],
        ["../shell/shell-hotkeys.ts", [/if \(!l\) return false;\s*if \(!gigAllows\("controllerLayout"\)\) return false;\s*ls\.setActive\(id\);/]],
        // The gate keeps the text of the dropped notification for the popover (F11), so the store
        // hands it over: the rule (a toast raised while locked is dropped) is the same.
        ["../plugins/plugin-store.ts", [/pushToast: \(message\) => \{\s*if \(!gigAllows\("showToast", message\)\) return;/]],
        ["../bridge/window.ts", [/close: async \(\) => \{\s*if \(gigGate\("closeWindow"\) === "confirm"\) \{\s*useGigStore\.getState\(\)\.setCloseAsk\(true\);\s*return;/]],
        // The doors to a settings change that are not the Settings modal (they all say the
        // Settings refusal): deck count / theme / surface in the palette, the shortcuts
        // overlay's rebind and reset-all, the skin try, the skin editor, the layout editor.
        [
            "../components/CommandPalette.tsx",
            [
                /function change\(run: \(\) => void\): \(\) => void \{\s*return \(\) => \{\s*if \(!gigAllows\("changeSettings"\)\) return;/,
                // The layout follows the deck count, the theme and the surface: every writer of
                // the palette that changes a setting goes through `change`.
                /onSelect: change\(\(\) => setDeckCount\(deckCount === 4 \? 2 : 4\)\)/,
                /onSelect: change\(\(\) => setPrefs\(\{ mode: resolvedMode === "dark" \? "light" : "dark" \}\)\)/,
            ],
        ],
        ["../components/ShortcutsOverlay.tsx", [/if \(on && !gigAllows\("changeSettings"\)\) return;\s*setCapturing\(on \? id : null\);/]],
        [
            "../state/keybind-store.ts",
            [
                /rebind: \(id, code\) => \{\s*if \(!SHORTCUTS_BY_ID\.has\(id\) \|\| !code\) return;\s*if \(!gigAllows\("changeSettings"\)\) return;/,
                /reset: \(id\) => \{\s*if \(!\(id in get\(\)\.overrides\)\) return;\s*if \(!gigAllows\("changeSettings"\)\) return;/,
                /resetAll: \(\) => \{\s*if \(!gigAllows\("changeSettings"\)\) return;/,
            ],
        ],
        [
            "../packs/pack-store.ts",
            [
                /startTry: \(pack, bytes, opts = \{\}\) => \{\s*if \(!gigAllows\("changeSettings"\)\) return;/,
                /if \(!gigAllows\("changeSettings"\)\) return;\s*if \(tryTimer\) clearTimeout\(tryTimer\);\s*const builtin = BUILTIN_SKINS/,
            ],
        ],
        [
            "../settings/skin-editor/store.ts",
            [
                /if \(!gigAllows\("changeSettings"\)\) return;\s*if \(usePackStore\.getState\(\)\.trying\) usePackStore\.getState\(\)\.endTry\(\);/,
                /save: async \(meta\) => \{\s*const s = get\(\);\s*if \(s\.busy\) return false;\s*if \(!gigAllows\("changeSettings"\)\) return false;/,
            ],
        ],
        [
            "../layout/LayoutEditor.tsx",
            [
                /layoutEditorBridge\.open = \(\) => \{\s*if \(!gigAllows\("changeSettings"\)\) return;/,
                /const save = \(\) => \{\s*if \(!gigAllows\("changeSettings"\)\) return;/,
            ],
        ],
    ];
    const asked = new Set<string>();
    for (const [rel, patterns] of gates) {
        const code = strip(read(rel));
        assert.match(code, /import \{[^}]*\bgig(?:Allows|Gate)\b[^}]*\} from "@\/gig\/gig-store";/, `${rel} does not import the gate`);
        for (const p of patterns) assert.match(code, p, `${rel}: gate missing or moved (${p.source.slice(0, 60)}...)`);
        // The gate may take a detail argument (`showToast` hands over the notification's text):
        // the action name is what matters here.
        for (const m of code.matchAll(/gig(?:Allows|Gate)\("(\w+)"/g)) asked.add(m[1]!);
    }
    // Every action of the closed list is asked for somewhere, and nothing outside the list is.
    assert.deepEqual([...asked].sort(), [...GIG_ACTIONS].sort());
});

test("a settings profile is only marked active when it was really applied", () => {
    // The gate lives in applySections; the profile switch must go through it and look at the
    // outcome, or a profile refused by the lock is shown as the active one.
    const code = strip(read("../settings/profiles-store.ts"));
    assert.match(code, /switchTo: async \(id, undoLabel\) => \{/);
    assert.match(code, /done\.outcome = await applySections\(p\.data\);/, "the profile switch does not apply through the gated path");
    assert.match(code, /if \(done\.outcome !== "applied"\) return false;\s*commit\(\{ \.\.\.state\(\), active: id \}\);/, "a refused apply still marks the profile active");
    // And applySections itself reports "locked" instead of applying.
    assert.match(strip(read("../settings/settings-live.ts")), /if \(!gigAllows\("applySettings"\)\) return "locked";/);
});

test("no gate decides by itself: the lock state is read only through the gate, outside src/gig", () => {
    for (const rel of ["../state/ui-store.ts", "../settings/hotkey.ts", "../settings/settings-live.ts", "../lib/cloud-sync.ts", "../shell/shell-hotkeys.ts", "../plugins/plugin-store.ts", "../bridge/window.ts"]) {
        const code = strip(read(rel));
        assert.doesNotMatch(code, /getState\(\)\.locked|\bdecide\(|LOCKED_VERDICT|mixai-gig/, `${rel} re-implements the rule`);
    }
    // The controls that open Settings only LOOK locked from the store's flag; the refusal is the gate's.
    for (const rel of ["../shell/StatusBar.tsx", "../shell/TitleBar.tsx", "../components/Library.tsx", "../settings/ProfileSwitcher.tsx"]) {
        const code = strip(read(rel));
        assert.match(code, /useGigLocked\(\)/, `${rel} does not show the locked state`);
        assert.match(code, /aria-disabled=\{(?:locked|gigLocked) \|\| undefined\}|data-gig-locked=\{locked \|\| undefined\}/, `${rel}: the control must stay focusable (aria-disabled, never the native disabled)`);
    }
});

test("the settings entry points all go through the gated store actions", () => {
    // Every file that opens Settings uses openSettings / setSettingsOpen of the ui store.
    const openers = ["../settings/hotkey.ts", "../shell/TitleBar.tsx", "../components/CommandPalette.tsx", "../components/Library.tsx", "../settings/ProfileSwitcher.tsx", "../shell/Onboarding.tsx", "../shell/StatusBar.tsx"];
    for (const rel of openers) {
        const code = strip(read(rel));
        assert.match(code, /openSettings\(|setSettingsOpen\(true\)/, `${rel} no longer opens Settings: update this list`);
        assert.doesNotMatch(code, /setState\(\{[^}]*settingsOpen: true/, `${rel} opens Settings behind the gate's back`);
    }
});

test("a controller that connected during the lock does not switch the layout after the unlock", () => {
    // Nothing remembers the device: the skip is a counter only.
    const hotkeys = strip(read("../shell/shell-hotkeys.ts"));
    assert.doesNotMatch(hotkeys, /pending|deferred|afterUnlock|useGigStore/, "shell-hotkeys must not queue a layout switch for later");
    const store = strip(read("./gig-store.ts"));
    assert.doesNotMatch(store, /controllerLayouts|setActive\(/);
});

test("the way to unlock is never hidden: the chip leaves the status-bar fit while locked or while its popover is open", () => {
    // shell/StatusBar.tsx hides `[data-prio]` items when the bar is narrow, and only un-hides items that still carry it.
    const bar = strip(read("../shell/StatusBar.tsx"));
    assert.match(bar, /querySelectorAll<HTMLElement>\("\[data-prio\]"\)/, "the status-bar fit no longer works by data-prio: check how the gig chip stays visible");
    const chip = strip(read("./GigChip.tsx"));
    assert.match(chip, /const pinned = locked \|\| open;/);
    assert.match(chip, /data-prio=\{pinned \? undefined : PRIO\}/);
    assert.match(chip, /if \(pinned && ref\.current\?\.hidden\) ref\.current\.hidden = false;\s*\}, \[pinned\]\);/);
});

// ─── 3. the lock is not a setting ────────────────────────────────────────────

test("the lock is stored under its own key and travels with no settings file, profile or cloud profile", () => {
    assert.equal(GIG_KEY, "mixai-gig");
    for (const rel of ["../settings/settings-io.ts", "../settings/settings-live.ts", "../settings/profiles-core.ts", "../settings/profiles-store.ts", "../lib/profile.ts", "../lib/cloud-sync.ts", "../state/ui-store.ts", "../shell/shell-prefs.ts"]) {
        const code = strip(read(rel));
        assert.ok(!code.includes(GIG_KEY), `${rel} reads or writes the lock key`);
        assert.doesNotMatch(code, /useGigStore\.getState\(\)\.(?:locked|since)|gigLocked|"gig"/, `${rel} carries the lock state`);
    }
    // The sections of a settings file are a closed list without anything of the lock.
    const io = read("../settings/settings-io.ts");
    const ids = /export const SECTION_IDS = \[([^\]]+)\] as const;/.exec(io);
    assert.ok(ids);
    assert.deepEqual([...ids[1]!.matchAll(/"(\w+)"/g)].map((m) => m[1]!), ["appearance", "layout", "audio", "midi", "hid", "keyboard", "plugins", "library"]);
    // Only the gig store writes the key.
    const store = strip(read("./gig-store.ts"));
    assert.match(store, /setItem\(GIG_KEY, encodeStored\(s\)\)/);
});

// ─── 4. the recorder's format ────────────────────────────────────────────────

test("the disk check assumes the format the recorder really writes", () => {
    const recorder = read("../../src-tauri/crates/mixai-core/src/recorder.rs");
    const spec = /let spec = WavSpec \{\s*channels: (\d+),\s*sample_rate,\s*bits_per_sample: (\d+),\s*sample_format: SampleFormat::(\w+),\s*\};/.exec(recorder);
    assert.ok(spec, "the WavSpec of the recorder was not found: the disk estimate must be checked again");
    assert.equal(Number(spec[1]), REC_CHANNELS);
    assert.equal(Number(spec[2]) / 8, REC_BYTES_PER_SAMPLE);
    assert.equal(spec[3], "Float");
});

// ─── 5. the fixes that live in the UI itself ─────────────────────────────────

test("the keyboard, the announcements and what going locked switches off are wired where they must be", () => {
    // F5: the close question and the chip's popover use up the bare arrows (the app's crossfader keys).
    for (const rel of ["./GigCloseDialog.tsx", "./GigChip.tsx"]) {
        const code = strip(read(rel));
        assert.match(code, /import \{[^}]*\bconsumeBareArrows\b[^}]*\} from "@\/remote\/remote-core";/, `${rel} does not import consumeBareArrows`);
        assert.match(code, /onKeyDown=\{\(e\) => \{\s*consumeBareArrows\(e\);\s*\}\}/, `${rel}: a bare arrow is not consumed inside it`);
    }
    // F8: the status region re-inserts its node (the same sentence said again is heard again), and the
    // gig sentences ask for longer on screen than the shell's 2.2 s default.
    const region = strip(read("../shell/StatusRegion.tsx"));
    assert.match(region, /data-announce-at=\{at \|\| undefined\}/);
    assert.match(region, /<span key=\{at\}>\{text\}<\/span>/, "the live node is not keyed on the time of the announcement");
    const hotkeys = read("../shell/shell-hotkeys.ts");
    assert.match(hotkeys, /say: \(text, ms\) =>/, "the region does not take a duration");
    assert.match(strip(hotkeys), /at: Math\.max\(Date\.now\(\), get\(\)\.at \+ 1\)/, "a repeated sentence must be a new event");
    const chip = strip(read("./GigChip.tsx"));
    const sayMs = Number(/export const SAY_MS = (\d+);/.exec(chip)?.[1] ?? "0");
    assert.ok(sayMs >= 4000, `a lock sentence stays on screen ${sayMs} ms: too short to read (F8 wants 4 s)`);
    assert.match(chip, /\.say\(translate\(locale, `gig\.say\.\$\{notice\.id\}`, vars\), SAY_MS\)/);
    // F10b: the chip says since when the lock is on.
    assert.match(chip, /t\("gig\.lockedSince", \{ since: at \}\)/);
    // F13: the status-bar tooltips drop their "Click for the ... settings" promise while locked.
    const bar = strip(read("../shell/StatusBar.tsx"));
    assert.match(bar, /const tip = locked \? lockedTip\(title, t\("gig\.lockedShort"\)\) : title;/);
    assert.match(bar, /aria-disabled=\{locked \|\| undefined\} title=\{tip\}/);
    // F3/F4: going locked switches both learn modes off and ends a running skin try.
    const runtime = strip(read("./gig-runtime.ts"));
    assert.match(runtime, /midiLearnOff: \(\) => engine\.midiSetLearn\(false\)/);
    assert.match(runtime, /if \(useHidStore\.getState\(\)\.learning\) useHidStore\.getState\(\)\.setLearning\(false\);/);
    assert.match(runtime, /endSkinTry: \(\) => \{\s*if \(usePackStore\.getState\(\)\.trying\) usePackStore\.getState\(\)\.endTry\(\);/);
    // ...and the two editors close themselves where their own state lives (the way their Cancel does).
    assert.match(strip(read("../settings/skin-editor/store.ts")), /if \(s\.locked && !prev\.locked && useSkinEditor\.getState\(\)\.open\) useSkinEditor\.getState\(\)\.setOpen\(false\);/);
    assert.match(strip(read("../layout/LayoutEditor.tsx")), /if \(gigLocked\) setOpen\(false\);\s*\}, \[gigLocked\]\);/);
    // F11: the texts of the hidden notifications are readable in the popover.
    const popover = strip(read("./GigPopover.tsx"));
    assert.match(popover, /const hidden = useGigStore\(\(s\) => s\.hidden\)/);
    assert.match(popover, /data-gig-hidden="">/, "the held tab does not list the hidden notification texts");
    // F12b: each row carries the time ITS result was taken, and closing the popover cancels a measurement.
    assert.match(popover, /data-gig-at=\{at\}/);
    assert.match(popover, /useGigChecks\.getState\(\)\.cancel\(\)/);
    // F14: the seconds of the measurement are on screen only, never in a live region.
    assert.match(popover, /data-gig-progress="" aria-hidden=\{measuring \|\| undefined\}/);
    assert.match(popover, /role="status" data-gig-run-status="">\s*\{measuring \? t\("gig\.runningStart"\) : done\}/);
});
