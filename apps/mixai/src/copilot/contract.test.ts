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
const popoverSrc = readFileSync(new URL("./CopilotPopover.tsx", import.meta.url), "utf8");
const ffiSrc = readFileSync(new URL("../../src-tauri/crates/decks-ffi/src/transition.rs", import.meta.url), "utf8");
const storeSrc = readFileSync(new URL("./copilot-store.ts", import.meta.url), "utf8");
const keyChipSrc = readFileSync(new URL("../components/KeyChip.tsx", import.meta.url), "utf8");
const rankSrc = readFileSync(new URL("../../src-tauri/crates/decks-transition/src/rank.rs", import.meta.url), "utf8");

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
    // The desktop asks for key-shift proposals by default (WP19-61), under the name the command declares.
    const ranked = calls.find((c) => c.cmd === "copilot_rank")!;
    assert.ok(commands.get("copilot_rank")!.includes("keyShift"), "copilot_rank no longer takes key_shift");
    assert.equal(ranked.args.keyShift, true);
    calls.length = 0;
    await copilot.rank(feat, [], "hold", 8, false);
    assert.equal(calls[0]!.args.keyShift, false, "the option can be switched off");
});

test("the key-shift proposal crosses the bridge under the same names, and only on the desktop", () => {
    // Result fields: named here, not only compared side to side (dropping one on both sides must fail too).
    for (const field of ["keyShift", "keyAfter"]) {
        assert.ok(rustFields("RankedOut").includes(field), `RankedOut.${field} missing in copilot.rs`);
        assert.ok(tsFields("Ranked").includes(field), `Ranked.${field} missing in bridge/copilot.ts`);
    }
    // Optional on the TypeScript side: a shell that predates proposals sends neither.
    assert.match(bridgeSrc, /keyShift\?: number \| null;/);
    assert.match(bridgeSrc, /keyAfter\?: string \| null;/);
    // Always serialised on the Rust side (null without a proposal): no skip attribute in the struct.
    const struct = /pub struct RankedOut \{([^}]*)\}/.exec(rust)![1]!;
    assert.ok(!struct.includes("skip_serializing"), "RankedOut must always send keyShift / keyAfter");
    // Left out by a caller = the plain ranking; the shell ranks through the crate's entry point with extras.
    assert.match(rust, /key_shift: key_shift\.unwrap_or\(false\)/);
    assert.match(rust, /dt::rank_next_with\(/);
    // The native apps (Android, iOS, Compose desktop) rank through decks-ffi: the plain ranking, no option.
    assert.match(ffiSrc, /dt::rank_next\(&p, &c, &opts\)/);
    assert.ok(!/rank_next_with|RankExtras|key_shift/.test(ffiSrc), "decks-ffi must keep the plain ranking");
    // The open popover ranks again when a deck's whole key shift changes (the reference key is the sounding key).
    assert.ok(popoverSrc.includes("const shifts = usePerfStore((s) => shiftsKey(s.decks));"), "the popover does not follow the decks' key shifts");
    assert.match(popoverSrc, /scheduleRefresh\(\);\s*\}, \[decks, clockSource, played, shifts\]\);/);
});

test("the fix-round rules are wired where the user meets them (source contract)", () => {
    // F2: the crate caps a proposal row below the lowest fit, only with the extra on, and
    // before the list is cut. `rank_next` goes through the same function with every extra off.
    const body = /pub fn rank_next_with\([\s\S]*?\n\}\n/.exec(rankSrc)?.[0] ?? "";
    assert.ok(body.length > 400, "rank_next_with not found in rank.rs");
    const cap = body.indexOf("if extras.key_shift {\n        cap_proposals_below_fits(&mut out);\n    }");
    assert.ok(cap > 0, "the cap is no longer applied under the key-shift extra only");
    assert.ok(cap < body.indexOf("out.sort_by(") && body.indexOf("out.sort_by(") < body.indexOf("out.truncate(opts.limit)"), "cap, then sort, then cut");
    assert.match(rankSrc, /pub fn rank_next\([\s\S]*?\{\s*rank_next_with\(playing, candidates, opts, RankExtras::default\(\)\)\s*\}/);
    assert.match(rankSrc, /\.filter\(\|r\| r\.key_shift\.is_none\(\) && r\.key >= KEY_FITS_FROM\)\s*\.map\(\|r\| r\.score\)\s*\.reduce\(f64::min\)/, "the cap is set by the LOWEST fit row");

    // F5: KeyChip's verdict can be overridden by one optional prop; left out, the chip judges by itself.
    assert.match(keyChipSrc, /verdict\?: KeyMatch \| null;/, "KeyChip.verdict must stay optional");
    assert.ok(keyChipSrc.includes("const match = verdict !== undefined ? verdict : against ? keyMatch(keyName, against) : null;"), "KeyChip no longer falls back to its own verdict");
    // ... and the co-pilot's row passes its own verdict (the ranking's score), for the same two keys.
    assert.ok(popoverSrc.includes("<KeyChip keyName={tr.keyCamelot} against={against} verdict={keyVerdict(tr.keyCamelot, against)} />"), "the row chip does not show the co-pilot's key verdict");
    assert.equal(popoverSrc.split("<KeyChip ").length - 1, 1, "one key chip in the popover");

    // F6: no key-shift button in a pop-out window, in the row and in the keyboard map; the store refuses too.
    assert.ok(storeSrc.includes('export const IN_POPOUT = typeof location !== "undefined" && isPopoutPage(location.search);'));
    assert.ok(popoverSrc.includes("shiftButtonState({ popout: IN_POPOUT, "), "the row does not ask whether this is a pop-out");
    assert.ok(popoverSrc.includes("const hasShift = shown.map((s) => !IN_POPOUT && target !== null && proposalOf(s.ranked) !== null);"));
    assert.ok(popoverSrc.includes('{proposal && target && state !== "none" && <ShiftButton '), "the button is rendered without asking its state");
    assert.match(storeSrc, /loadShifted: async \(deck, track, shift\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(IN_POPOUT \|\| /, "loadShifted must refuse in a pop-out before anything else");

    // F7: the button is never natively disabled, shows its state, and a press in flight reaches the store.
    const button = /function ShiftButton\([\s\S]*?\n\}\n/.exec(popoverSrc)?.[0] ?? "";
    assert.ok(button.length > 300, "ShiftButton not found");
    assert.ok(!/\sdisabled[=\s>]/.test(button), "no native disabled on the key-shift button");
    assert.ok(button.includes("aria-disabled={shiftButtonSoft(state) || undefined}"));
    assert.ok(button.includes('aria-busy={state === "busy" || undefined}'));
    assert.ok(button.includes('onClick={state === "done" ? undefined : () => void useCopilotStore.getState().loadShifted(deck, track, shift)}'), "a press while loading / on a playing deck must reach the store (it answers in the status line)");
    for (const [state, key] of [
        ["load", "copilot.loadShift"],
        ["shift", "copilot.shiftOnly"],
        ["busy", "copilot.shiftLoading"],
        ["done", "copilot.shiftApplied"],
        ["playing", "copilot.shiftOffPlaying"],
    ]) {
        assert.ok(popoverSrc.includes(`    ${state}: "${key}",`), `the ${state} state has no name`);
    }
    // The row learns "the incoming deck plays" and "a load is in flight" from the stores.
    assert.ok(popoverSrc.includes("const targetPlaying = useMixerStore((s) => (target ? s.deck(target).loaded && s.deck(target).playing : false));"));
    assert.ok(popoverSrc.includes('const loading = useCopilotStore((s) => (target ? (s.shifting[target] ?? "") : ""));'));
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
    assert.ok(reasons.size >= 20, `reason tags found: ${reasons.size}`);
    assert.ok(reasons.has("key_shiftable"), "the key-shift reason tag is not seen in rank.rs");
    for (const r of reasons) assert.ok(keys.has(`copilot.reason.${r}`), `copilot.reason.${r} missing`);
    // ... and an entry in the popover's tag table (a tag without one is shown as raw words).
    const table = /const REASON_KEY: Record<string, MessageKey> = \{([^}]*)\}/.exec(popoverSrc)?.[1] ?? "";
    for (const r of reasons) assert.ok(table.includes(`${r}: "copilot.reason.${r}"`), `REASON_KEY has no entry for ${r}`);
    // The texts the key-shift row, button and status line use exist in both languages.
    for (const k of ["reason.keyShift", "loadShift", "shiftOnly", "shiftApplied", "shiftLoading", "shiftOffPlaying", "shiftOn", "shiftUndone", "shiftLost", "shiftBusy", "shiftDeckPlaying", "shiftSkippedPlaying", "nextClashes"]) {
        assert.ok(keys.has(`copilot.${k}`), `copilot.${k} missing (en)`);
        assert.ok(`copilot.${k}` in copilotMessages.ro, `copilot.${k} missing (ro)`);
    }
    // Every text names what it is about: the same variables in both languages.
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(",");
    for (const [k, want] of [
        ["shiftLoading", "deck,key,shift,title"],
        ["shiftOffPlaying", "deck,key,shift,title"],
        ["shiftBusy", "deck"],
        ["shiftDeckPlaying", "deck"],
        ["shiftSkippedPlaying", "deck,shift"],
        ["nextClashes", "deck,deck,key,shift,title"],
    ] as const) {
        const key = `copilot.${k}` as const;
        assert.equal(vars(copilotMessages.en[key]), want, `${key} (en)`);
        assert.equal(vars(copilotMessages.ro[key]), want, `${key} (ro)`);
    }
    // "Not applied: deck B was already playing": the sentence the status line shows says both.
    assert.match(copilotMessages.en["copilot.shiftSkippedPlaying"], /not applied.*already playing/i);
    assert.match(copilotMessages.ro["copilot.shiftSkippedPlaying"], /nu s-a aplicat.*deja în redare/i);
    // The reason says the shift and the key it leads to, with an arrow as text.
    for (const lang of ["en", "ro"] as const) {
        const text: string = copilotMessages[lang]["copilot.reason.keyShift"];
        assert.ok(text.includes("{shift}") && text.includes("{key}") && text.includes("→"), `${lang}: ${text}`);
    }
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
