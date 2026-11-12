// Run: node --test apps/mixai/src/copilot/contract.test.ts
//
// The wire contract between bridge/copilot.ts and src-tauri/src/copilot.rs, checked against the
// Rust SOURCE (not a copy of it): every wrapper sends exactly the parameters its command
// declares, every command is registered in lib.rs, and the TypeScript mirrors have the fields
// the Rust structs serialise. A renamed parameter otherwise fails only at run time, in the
// native app ("missing required key ...").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PlanInfo, TrackFeat } from "../bridge/copilot.ts";

const rust = readFileSync(new URL("../../src-tauri/src/copilot.rs", import.meta.url), "utf8");
const lib = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
const bridgeSrc = readFileSync(new URL("../bridge/copilot.ts", import.meta.url), "utf8");

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Split on commas that are not inside `<...>` (`State<'_, CopilotCtl>` is one parameter). */
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

/** `#[tauri::command] pub fn name(params)` → name → parameter names the webview must send (camelCase). */
function rustCommands(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const m of rust.matchAll(/#\[tauri::command\]\s*pub fn (\w+)\(([^)]*)\)/g)) {
        const params = splitParams(m[2]!)
            .map((p) => ({ name: p.slice(0, p.indexOf(":")).trim(), type: p.slice(p.indexOf(":") + 1).trim() }))
            // Injected by Tauri, never sent by the webview.
            .filter((p) => !/^(State<|tauri::AppHandle|tauri::Window)/.test(p.type))
            .map((p) => camel(p.name));
        out.set(m[1]!, params);
    }
    return out;
}

/** Serialised field names of a `struct Name { field: T, ... }` (public or not) with `rename_all = "camelCase"`. */
function rustFields(name: string): string[] {
    const m = new RegExp(`((?:#\\[[^\\]]*\\]\\s*)*)(?:pub )?struct ${name} \\{([^}]*)\\}`).exec(rust);
    assert.ok(m, `struct ${name} not found in copilot.rs`);
    assert.match(m[1]!, /rename_all = "camelCase"/, `${name} must serialise as camelCase`);
    return [...m[2]!.matchAll(/^\s*(?:pub )?(\w+):/gm)].map((f) => camel(f[1]!)).sort();
}

/** Field names of `export interface Name { ... }` in bridge/copilot.ts. */
function tsFields(name: string): string[] {
    const m = new RegExp(`export interface ${name} \\{([^}]*)\\}`).exec(bridgeSrc);
    assert.ok(m, `interface ${name} not found in bridge/copilot.ts`);
    return [...m[1]!.matchAll(/^\s*(\w+)\??:/gm)].map((f) => f[1]!).sort();
}

const feat: TrackFeat = { id: "1", title: "t", artist: "a", bpm: 128, key: "8A", energy: 6, durationSec: 300, firstBeatSec: 0, downbeatOffset: 0, lufs: null, hasStems: false };
const plan: PlanInfo = { style: "cut", bars: 1, startSec: 1, beatsUntilStart: 0, toCueSec: 0, toTempoRatio: 1, automationJson: "{}", reasons: [], fromDeck: "a", toDeck: "b", lengthBeats: 4 };

test("every bridge wrapper sends exactly the parameters its Rust command declares", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    // The bridge only needs `window.__TAURI_INTERNALS__.invoke` (what @tauri-apps/api calls).
    (globalThis as Record<string, unknown>).window = {
        __TAURI_INTERNALS__: {
            invoke: (cmd: string, args: Record<string, unknown> = {}) => {
                calls.push({ cmd, args });
                return Promise.resolve(null);
            },
        },
    };
    const { copilot } = await import("../bridge/copilot.ts");
    await copilot.rank(feat, [{ track: feat, playedMinutesAgo: null }], "up", 8);
    await copilot.plan({ from: feat, to: feat, fromDeck: "a", toDeck: "b", fromPosSec: 10 });
    await copilot.run(plan);
    await copilot.cancel();
    await copilot.status();
    await copilot.safety({ playing: feat, positionSec: 1, tempoRatio: 1, next: null, plannedBars: null });
    await copilot.intent("mix next");
    await copilot.intentSchema();

    const commands = rustCommands();
    assert.equal(commands.size, 8, `commands found in copilot.rs: ${[...commands.keys()].join(", ")}`);
    assert.deepEqual(calls.map((c) => c.cmd).sort(), [...commands.keys()].sort(), "one wrapper per command");
    for (const { cmd, args } of calls) {
        assert.deepEqual(Object.keys(args).sort(), [...commands.get(cmd)!].sort(), `${cmd}: argument names`);
        assert.match(lib, new RegExp(`copilot::${cmd},`), `${cmd} is not registered in lib.rs`);
    }
    // The plan travels as one JSON string that carries the automation and the deck names apart.
    const run = calls.find((c) => c.cmd === "copilot_run")!;
    assert.deepEqual(JSON.parse(run.args.planJson as string), plan);
    assert.deepEqual([run.args.fromDeck, run.args.toDeck], ["a", "b"]);
    // Optional values are sent as null, never left out as undefined-with-a-key.
    const planned = calls.find((c) => c.cmd === "copilot_plan")!;
    assert.deepEqual([planned.args.bars, planned.args.style], [null, null]);
});

test("the TypeScript mirrors have the fields the Rust structs serialise", () => {
    for (const [rs, ts] of [
        ["TrackFeat", "TrackFeat"],
        ["CandidateIn", "Candidate"],
        ["RankedOut", "Ranked"],
        ["PlanInfo", "PlanInfo"],
        ["Progress", "Progress"],
        ["WarningOut", "SafetyWarning"],
        ["IntentOut", "Intent"],
    ] as const) {
        assert.deepEqual(tsFields(ts), rustFields(rs), `${ts} (TS) vs ${rs} (Rust)`);
    }
    // What `copilot_run` reads back from the plan must be fields the plan has.
    const read = rustFields("RunPlanIn");
    const has = new Set(rustFields("PlanInfo"));
    assert.ok(read.length >= 3 && read.every((f) => has.has(f)), `RunPlanIn reads ${read.join(", ")}`);
});

test("the progress event name is the same on both sides", () => {
    const name = /const EVENT: &str = "([^"]+)";/.exec(rust)?.[1];
    assert.equal(name, "copilot://progress");
    assert.ok(bridgeSrc.includes(`listen<Progress>("${name}"`), "bridge listens on another event name");
});

test("every reason / warning / style the crate can emit has a catalogue entry", async () => {
    const { copilotMessages } = await import("../i18n/messages-copilot.ts");
    const keys = new Set(Object.keys(copilotMessages.en));
    const crate = (file: string) => readFileSync(new URL(`../../src-tauri/crates/decks-transition/src/${file}`, import.meta.url), "utf8");
    // rank.rs + camelot.rs: reason tags of a suggestion.
    const rank = crate("rank.rs").split("#[cfg(test)]")[0]! + crate("camelot.rs").split("#[cfg(test)]")[0]!;
    const reasons = new Set([...rank.matchAll(/"((?:key|tempo|energy)_[a-z]+|recently_played|same_artist|stems_ready)"/g)].map((m) => m[1]!));
    assert.ok(reasons.size >= 19, `reason tags found: ${reasons.size}`);
    for (const r of reasons) assert.ok(keys.has(`copilot.reason.${r}`), `copilot.reason.${r} missing`);
    // plan.rs: reason tags of a plan.
    const planSrc = crate("plan.rs").split("#[cfg(test)]")[0]!;
    const why = new Set([...planSrc.matchAll(/reasons\.push\("([a-z_]+)"\.into\(\)\)/g)].map((m) => m[1]!));
    assert.ok(why.size >= 9, `plan reasons found: ${why.size}`);
    for (const r of why) assert.ok(keys.has(`copilot.why.${r}`), `copilot.why.${r} missing`);
    // Styles and warning codes as the shell names them.
    for (const m of rust.matchAll(/dt::Style::\w+ => "([a-z_]+)"/g)) {
        assert.ok(keys.has(`copilot.style.${m[1]}`) && keys.has(`copilot.styleShort.${m[1]}`), `style ${m[1]} missing`);
    }
    const codes = new Set([...rust.matchAll(/out\.code = "([a-z_]+)"\.into\(\)/g)].map((m) => m[1]!));
    assert.equal(codes.size, 6, `warning codes found: ${[...codes].join(", ")}`);
    for (const c of codes) assert.ok(keys.has(`copilot.warn.${c}`), `copilot.warn.${c} missing`);
});
