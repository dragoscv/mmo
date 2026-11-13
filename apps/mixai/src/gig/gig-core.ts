/**
 * Gig lock + checklist: the pure part (no DOM, no store, no bridge; unit-tested in
 * gig-core.test.ts and loadable under `node --test`).
 *
 * 1. THE RULE. `decide(locked, action)` is the only place that says what the lock blocks. Every
 *    gate in the app asks it through `gigAllows` (gig-store.ts); no gate re-implements it.
 * 2. The stored form of the lock (`parseStored` / `encodeStored`): unreadable = unlocked, so a
 *    stuck lock is impossible.
 * 3. The two-step unlock (`requestUnlock` / `confirmUnlock` / `expireUnlock`), on a clock the
 *    caller passes in.
 * 4. The checklist: every check is classified into ok / warn / problem / unknown with a reason id
 *    (the UI turns `gig.r.<reason>` into a sentence and, for warn / problem, `gig.fix.<reason>`
 *    into what to do).
 * 5. Guards for what the shell answers (`parseShell`, `parseSystem`): an older or newer shell
 *    must never put a wrong type into the UI.
 * 6. Small procedures with every outside call injected, so they are tested with stand-ins:
 *    the shell sync with its bounded retry (`runShellSync`), "Close anyway" (`closeAnyway`:
 *    the ENGINE says whether a recording runs), what going locked switches off (`enforceLock`).
 */
import { LOAD_ALERT, LOAD_WARN, loadPct, shortDevice } from "../shell/status-math.ts";

// ─── 1. the rule ─────────────────────────────────────────────────────────────

/**
 * Everything the lock knows about (closed list). NOT in it, on purpose: the layout snapshot
 * hotkeys (Alt+1..8), the layout menu and stage mode (Ctrl+Shift+S). Those are things the DJ
 * does with their own hands during a set; the lock stops what happens by itself or by a slip
 * into Settings, not the performance controls.
 *
 * `applySettings` = a settings write that was not asked for at this moment (import, reset,
 * profile, undo, the cloud profile): silent. `changeSettings` = a settings change the DJ asked
 * for through a door that is not the Settings modal (command palette, shortcuts overlay, skin
 * try, skin editor, layout editor): refused with the same sentence as opening Settings.
 */
export const GIG_ACTIONS = ["openSettings", "applySettings", "changeSettings", "switchProfile", "cloudPull", "cloudPush", "controllerLayout", "showToast", "closeWindow"] as const;
export type GigAction = (typeof GIG_ACTIONS)[number];

/** allow = go on; skip = do nothing (and say "skipped: locked"); confirm = ask the DJ first. */
export type GigVerdict = "allow" | "skip" | "confirm";

/** What each action gets while the lock is ON. Off = everything is allowed. */
export const LOCKED_VERDICT: Readonly<Record<GigAction, GigVerdict>> = {
    openSettings: "skip",
    applySettings: "skip",
    changeSettings: "skip",
    switchProfile: "skip",
    cloudPull: "skip",
    cloudPush: "skip",
    controllerLayout: "skip",
    showToast: "skip",
    closeWindow: "confirm",
};

/** The main window, or a pop-out (one panel in its own window). */
export type WindowKind = "main" | "popout";

export function decide(locked: boolean, action: GigAction, win: WindowKind = "main"): GigVerdict {
    if (!locked) return "allow";
    // A pop-out window closes without asking: the set runs in the main window.
    if (action === "closeWindow" && win === "popout") return "allow";
    return LOCKED_VERDICT[action];
}

/** What the app says in the status region (the sentence is `gig.say.<notice>`). */
export type GigNotice = "openSettings" | "switchProfile" | "locked" | "unlocked" | "armedKey" | "startLocked" | "lockExpired";

/**
 * Refusals the DJ caused with a click or a key, with the sentence each gets. The others are
 * silent. Every door to a settings change says the same thing as the Settings modal.
 */
export const REFUSAL_NOTICE: Readonly<Partial<Record<GigAction, GigNotice>>> = {
    openSettings: "openSettings",
    changeSettings: "openSettings",
    switchProfile: "switchProfile",
};
export const SPOKEN_REFUSALS: readonly GigAction[] = ["openSettings", "changeSettings", "switchProfile"];

/** A plugin notification the lock dropped: kept (a few, in memory) so the DJ can look. */
export interface HiddenToast {
    text: string;
    /** Epoch ms it was raised. */
    at: number;
}
/** How many dropped notifications are kept, and how much of each. */
export const HIDDEN_MAX = 5;
export const HIDDEN_TEXT_MAX = 140;

/** The list with one more dropped notification: newest last, never more than `HIDDEN_MAX`, each text cut. */
export function noteHidden(list: readonly HiddenToast[], text: unknown, at: number): readonly HiddenToast[] {
    const clean = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
    const next = [...list, { text: clean ? clip(clean, HIDDEN_TEXT_MAX) : "?", at }];
    return next.length > HIDDEN_MAX ? next.slice(next.length - HIDDEN_MAX) : next;
}

/** What was held back while locked (shown in the popover; reset when the lock goes on). */
export interface Skipped {
    /** Plugin notifications dropped. */
    toasts: number;
    /** Controller connects that did not switch the layout. */
    layouts: number;
    /** A cloud pull was held back: it runs once at unlock. */
    cloudPull: boolean;
    /** A cloud push was held back: it runs once at unlock, after the pull. */
    cloudPush: boolean;
}

export const NOTHING_SKIPPED: Skipped = { toasts: 0, layouts: 0, cloudPull: false, cloudPush: false };

/**
 * Record one skipped action. Returns the SAME object when nothing changed (a held cloud sync is
 * one fact however often it is asked), so a store can tell there is nothing to publish.
 */
export function noteSkip(s: Skipped, action: GigAction): Skipped {
    switch (action) {
        case "showToast":
            return { ...s, toasts: s.toasts + 1 };
        case "controllerLayout":
            return { ...s, layouts: s.layouts + 1 };
        case "cloudPull":
            return s.cloudPull ? s : { ...s, cloudPull: true };
        case "cloudPush":
            return s.cloudPush ? s : { ...s, cloudPush: true };
        default:
            return s;
    }
}

/**
 * How a pull of the account's profile ended (gig/held-sync.ts). "unreadable" = the account
 * holds something that is not a profile: nothing was applied. "kept" = a local change was
 * owed to the account, so nothing was applied and the local profile was uploaded instead.
 */
export type PullOutcome = "applied" | "empty" | "failed" | "skipped" | "unreadable" | "kept";

/**
 * The cloud sync the lock held back, when the lock is released. First step: the account copy
 * is pulled BEFORE anything is uploaded (the order lib/cloud-sync.ts keeps at start and at
 * sign-in); a held push alone goes out as it would have.
 */
export function releaseFirst(held: { pull: boolean; push: boolean }): "pull" | "push" | null {
    return held.pull ? "pull" : held.push ? "push" : null;
}

/**
 * After that pull: does the held push still go out? Only when the pull changed nothing here
 * (nothing usable stored in the account, or the account could not be reached). A pull that was
 * applied has replaced the local state, and the module never uploads what it just pulled.
 * (A REAL local change held by the lock does not come this way: it leaves a marker and wins,
 * see gig/held-sync.ts.)
 */
export function pushAfterPull(outcome: PullOutcome, heldPush: boolean): boolean {
    return heldPush && (outcome === "empty" || outcome === "failed" || outcome === "unreadable");
}

// ─── 2. stored form ──────────────────────────────────────────────────────────

/** localStorage key of the lock. Its own key: NOT part of the settings file or the cloud profile. */
export const GIG_KEY = "mixai-gig";
export const GIG_STORE_VERSION = 1;

export interface StoredGig {
    locked: boolean;
    /** Epoch ms the lock went on (0 = not known). */
    since: number;
}

export const UNLOCKED: StoredGig = { locked: false, since: 0 };

/**
 * A stored lock older than this is dropped when the app starts: "Close anyway" keeps the lock
 * so that a restart in the middle of a set comes back locked, but the next day the set is over.
 */
export const LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * The stored lock as the app takes it at start (`now` = wall clock). A lock whose time is
 * known and more than `LOCK_MAX_AGE_MS` ago starts unlocked (`expired`). A lock without a
 * usable time, or with a time in the future (the clock was set back), is kept: its age cannot
 * be shown to be over the limit, and the DJ can always unlock.
 */
export function loadStored(raw: string | null | undefined, now: number): { state: StoredGig; expired: boolean } {
    const state = parseStored(raw);
    if (state.locked && state.since > 0 && Number.isFinite(now) && now - state.since > LOCK_MAX_AGE_MS) return { state: UNLOCKED, expired: true };
    return { state, expired: false };
}

/**
 * Read the stored lock. Anything that is not exactly an object with `locked: true` reads as
 * unlocked: a corrupt, truncated or foreign value can never leave the app locked. A value
 * written by a later version (`v` above ours) is honoured only for that one boolean.
 */
export function parseStored(raw: string | null | undefined): StoredGig {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 400) return UNLOCKED;
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch {
        return UNLOCKED;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) return UNLOCKED;
    const o = data as Record<string, unknown>;
    if (o.locked !== true) return UNLOCKED;
    const since = typeof o.since === "number" && Number.isFinite(o.since) && o.since > 0 ? Math.floor(o.since) : 0;
    return { locked: true, since };
}

export function encodeStored(s: StoredGig): string {
    return JSON.stringify({ v: GIG_STORE_VERSION, locked: s.locked, since: s.locked ? s.since : 0 });
}

// ─── 3. two-step unlock ──────────────────────────────────────────────────────

/** After "Unlock", "Confirm" must come within this long. */
export const UNLOCK_WINDOW_MS = 5000;
/** ...and not sooner than this: a double click (500 ms on Windows) or a bounced key is one step, not two. */
export const UNLOCK_MIN_MS = 600;

/** Epoch ms of the first step, or null when no unlock is under way. */
export type Armed = number | null;

/** Step 1. Only a locked app can be armed. */
export function requestUnlock(locked: boolean, now: number): Armed {
    return locked && Number.isFinite(now) ? now : null;
}

/** Step 2: does this confirm unlock? The state is checked again (the lock may be gone, the first step may be stale). */
export function confirmUnlock(locked: boolean, armed: Armed, now: number): boolean {
    if (!locked || armed === null || !Number.isFinite(now)) return false;
    const age = now - armed;
    return age >= UNLOCK_MIN_MS && age <= UNLOCK_WINDOW_MS;
}

/** The first step as it stands at `now`: null once the window has passed (or the clock went back). */
export function expireUnlock(armed: Armed, now: number): Armed {
    if (armed === null) return null;
    const age = now - armed;
    return age >= 0 && age <= UNLOCK_WINDOW_MS ? armed : null;
}

/** What one press of the unlock control (button or hotkey) did. */
export type UnlockStep = "idle" | "armed" | "wait" | "unlocked";

/**
 * One press of the unlock control at `now`: the first press arms, a second one inside the
 * window unlocks, a second one that comes too soon is the same gesture ("wait": nothing
 * changes), and a press after the window has passed arms again. A press that comes right
 * after the lock went on (`since`) is the tail of the click that locked: it does not arm.
 * Returns the step and the armed time to keep.
 */
export function unlockPress(locked: boolean, armed: Armed, now: number, since = 0): { step: UnlockStep; armed: Armed } {
    if (!locked) return { step: "idle", armed: null };
    const live = expireUnlock(armed, now);
    if (live === null) {
        if (now >= since && now - since < UNLOCK_MIN_MS) return { step: "wait", armed: null };
        return { step: "armed", armed: requestUnlock(locked, now) };
    }
    if (!confirmUnlock(locked, live, now)) return { step: "wait", armed: live };
    return { step: "unlocked", armed: null };
}

/**
 * Why a press of "Confirm" did not unlock, for the hint next to it: "early" = inside the
 * double-click guard (wait a moment), "late" = the 5 seconds are over, "none" = no first step
 * was taken. Null = it does unlock (or nothing is locked).
 */
export function confirmRefusal(locked: boolean, armed: Armed, now: number): "early" | "late" | "none" | null {
    if (!locked) return null;
    if (armed === null) return "none";
    if (confirmUnlock(locked, armed, now)) return null;
    return now - armed < UNLOCK_MIN_MS && now >= armed ? "early" : "late";
}

/** The lock hotkey as text for this system ("Cmd+Shift+G" on macOS). */
export function hotkeyText(platform: string): string {
    return platform === "macos" ? "Cmd+Shift+G" : "Ctrl+Shift+G";
}

/**
 * A status-bar tooltip while the lock is on: the sentence that promises "Click for the ...
 * settings" (EN "Click ...", RO "Clic ...", always the last one) is dropped and `locked`
 * ("Locked for the set") is said instead.
 */
export function lockedTip(tip: string, locked: string): string {
    const kept = tip.replace(/(^|[.!?]\s+|\n)(?:Click|Clic)\b[^.!?\n]*[.!?]?\s*$/u, "$1").trimEnd();
    return kept ? `${kept} ${locked}` : locked;
}

// ─── 4. checklist ────────────────────────────────────────────────────────────

export type CheckState = "ok" | "warn" | "problem" | "unknown";
export const CHECK_IDS = ["audio", "power", "disk", "dropouts", "library", "controller"] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export type Vars = Record<string, string | number>;

export interface CheckResult {
    state: CheckState;
    /** Reason id: the sentence is `gig.r.<reason>`, the advice (warn / problem) `gig.fix.<reason>`. */
    reason: string;
    vars: Vars;
}

const res = (state: CheckState, reason: string, vars: Vars = {}): CheckResult => ({ state, reason, vars });

/** Every reason a check can give, with the state it always has (pinned by the tests and by the catalogue). */
export const REASONS = {
    "audio.preview": "unknown",
    "audio.noEngine": "problem",
    "audio.deviceMissing": "problem",
    "audio.recStopped": "warn",
    "audio.fellBack": "warn",
    "audio.fellBackBuffer": "warn",
    "audio.fellBackRate": "warn",
    "audio.lowRate": "warn",
    "audio.bigBuffer": "warn",
    "audio.okDefault": "ok",
    "audio.ok": "ok",
    "power.na": "unknown",
    "power.unknown": "unknown",
    "power.mains": "ok",
    "power.mainsPct": "ok",
    "power.battery": "warn",
    "power.batteryPct": "warn",
    "power.low": "problem",
    "disk.na": "unknown",
    "disk.error": "unknown",
    "disk.unknown": "unknown",
    "disk.network": "warn",
    "disk.ok": "ok",
    "disk.okCap": "ok",
    "disk.capShort": "warn",
    "disk.short": "warn",
    "disk.full": "problem",
    "dropouts.na": "unknown",
    "dropouts.notRun": "unknown",
    "dropouts.cancelled": "unknown",
    "dropouts.restart": "unknown",
    "dropouts.xruns": "problem",
    "dropouts.over": "problem",
    "dropouts.high": "warn",
    "dropouts.okIdle": "ok",
    "dropouts.ok": "ok",
    "library.preview": "unknown",
    "library.offline": "problem",
    "library.unpaired": "warn",
    "library.none": "warn",
    "library.ok": "ok",
    "library.okCount": "ok",
    "library.okUnknown": "ok",
    "library.okNotLocal": "ok",
    "controller.preview": "unknown",
    "controller.none": "unknown",
    "controller.ble": "ok",
    // A MIDI port the system lists is not proof of a connected, mapped controller.
    "controller.midi": "unknown",
    "controller.midiMore": "unknown",
} as const satisfies Record<string, CheckState>;
export type Reason = keyof typeof REASONS;

const give = (reason: Reason, vars: Vars = {}): CheckResult => res(REASONS[reason], reason, vars);

/** Longest piece of outside text (a device name, the shell's own error words) a sentence carries: a checklist row is two lines. */
export const NOTE_MAX = 48;
export const DEVICE_MAX = 32;

/** `s` cut to `max` characters (whole code points), with an ellipsis when something was cut. */
export function clip(s: string, max: number): string {
    const chars = Array.from(s.trim());
    return chars.length <= max ? chars.join("") : chars.slice(0, Math.max(1, max - 1)).join("") + "\u2026";
}

// ── audio ──

/** A buffer above this is hard to cue and scratch on (typical DJ buffers: 5 to 12 ms). */
export const BUFFER_WARN_MS = 25;
/** Below CD rate the engine resamples everything down. */
export const RATE_WARN_HZ = 44100;

export interface AudioInput {
    /** Running in the desktop app (false = browser preview, no engine at all). */
    native: boolean;
    /** What the engine opened; null = the engine did not start. */
    info: { deviceId: string | null; deviceName: string | null; sampleRate: number; notes: readonly string[] } | null;
    /** Output devices of the system; null = not known. */
    devices: readonly { id: string; isDefault: boolean }[] | null;
    /** Settled buffer latency in ms (0 = not known yet). */
    latencyMs: number;
}

const oneDecimal = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

/**
 * What a fallback note of the engine is about. The notes are English log sentences written in
 * crates/mixai-core (engine.rs, output.rs); every one starts with what it is about, and
 * gig-core.test.ts reads those two files and classifies each note found there.
 */
export type NoteKind = "deviceMissing" | "recStopped" | "buffer" | "rate" | "other";

export function noteKind(note: string): NoteKind {
    const n = note.trim();
    if (/^output device\b[\s\S]*\bnot found\b/i.test(n)) return "deviceMissing";
    // "recording stopped: the sample rate changed ..." is about the recording, not a refused setting.
    if (/^recording stopped\b/i.test(n)) return "recStopped";
    if (/^buffer_frames\b/i.test(n)) return "buffer";
    if (/^sample_rate\b/i.test(n)) return "rate";
    return "other";
}

/** `n` with one decimal in the language of the UI ("48.0" / "48,0"). */
export function formatDecimal(n: number, locale: string): string {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
}

export function classifyAudio(i: AudioInput): CheckResult {
    if (!i.native) return give("audio.preview");
    if (!i.info) return give("audio.noEngine");
    // The engine's notes are sorted by what they are about, never shown as they are.
    const kinds = new Set(i.info.notes.filter((n) => typeof n === "string" && n.trim().length > 0).map(noteKind));
    if (kinds.has("deviceMissing")) return give("audio.deviceMissing");
    if (kinds.has("recStopped")) return give("audio.recStopped");
    if (kinds.has("buffer")) return give("audio.fellBackBuffer");
    if (kinds.has("rate")) return give("audio.fellBackRate");
    if (kinds.size > 0) return give("audio.fellBack");
    // The same short name the status bar shows ("Speakers (DDJ-FLX4)" -> "DDJ-FLX4").
    const device = clip(shortDevice(i.info.deviceName ?? "") || "?", DEVICE_MAX);
    // Numbers stay numbers: the UI writes them with the decimal sign of its language.
    const khz = Number(oneDecimal(i.info.sampleRate / 1000));
    const ms = i.latencyMs > 0 && Number.isFinite(i.latencyMs) ? Number(oneDecimal(i.latencyMs)) : "?";
    const vars = { device, khz, ms };
    if (!(i.info.sampleRate >= RATE_WARN_HZ)) return give("audio.lowRate", vars);
    if (i.latencyMs > BUFFER_WARN_MS) return give("audio.bigBuffer", vars);
    // Playing through the system default while other outputs exist is right for many set-ups
    // and a classic mistake for the rest: it is said, not judged.
    const opened = i.devices?.find((d) => d.id === i.info!.deviceId);
    if (opened?.isDefault && (i.devices?.length ?? 0) > 1) return give("audio.okDefault", vars);
    return give("audio.ok", vars);
}

// ── power ──

/** On battery below this many percent a set will not finish: a problem, not a warning. */
export const BATTERY_LOW_PCT = 20;

export type PowerSource = "mains" | "battery" | "unknown";
export interface PowerStatus {
    source: PowerSource;
    /** 0..100 when known. */
    percent: number | null;
    charging: boolean | null;
}

/** `null` = the shell cannot tell (older shell, browser preview). */
export function classifyPower(p: PowerStatus | null): CheckResult {
    if (!p) return give("power.na");
    const pct = p.percent;
    if (p.source === "mains") return pct === null ? give("power.mains") : give("power.mainsPct", { pct });
    if (p.source === "battery") {
        if (pct === null) return give("power.battery");
        return pct < BATTERY_LOW_PCT ? give("power.low", { pct }) : give("power.batteryPct", { pct });
    }
    return give("power.unknown");
}

// ── disk ──

/**
 * The recorder writes 32-bit float stereo WAV at the engine's sample rate
 * (crates/mixai-core/src/recorder.rs; contract.test.ts reads that file and fails when the
 * format changes without these two numbers).
 */
export const REC_CHANNELS = 2;
export const REC_BYTES_PER_SAMPLE = 4;
/** Room for a set of this many minutes = ok. */
export const SET_MINUTES = 120;
/** Less room than this many minutes = a problem. */
export const SET_MINUTES_MIN = 30;

/**
 * The recorder writes a classic WAV file: its two length fields are 32 bits (hound keeps the
 * data length in a `u32`), so ONE recording file cannot hold more than 4 GiB whatever the disk
 * has free. A little is left for the header.
 */
export const WAV_MAX_DATA_BYTES = 2 ** 32 - 1 - 128;

/** Whole minutes one recording file can hold at `sampleRate` (48 kHz: 186 = 3 h 06 min; 96 kHz: 93). */
export function wavMaxMinutes(sampleRate: number): number {
    return Math.floor(WAV_MAX_DATA_BYTES / recBytesPerMinute(sampleRate));
}

/** Bytes one minute of recording takes at `sampleRate` (48 kHz: 23 040 000). */
export function recBytesPerMinute(sampleRate: number): number {
    const sr = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    return sr * REC_CHANNELS * REC_BYTES_PER_SAMPLE * 60;
}

/** Whole minutes of recording that fit in `freeBytes`. */
export function recMinutes(freeBytes: number, sampleRate: number): number {
    if (!(freeBytes > 0)) return 0;
    return Math.floor(freeBytes / recBytesPerMinute(sampleRate));
}

/** Minutes as "45 min" / "3 h 05 min" / "120 h" (units are the same in EN and RO; no plural forms). */
export function minutesText(minutes: number): string {
    const m = Math.max(0, Math.floor(minutes));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    // Past four days the minutes say nothing.
    if (h >= 100) return `${h} h`;
    return `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

export interface DiskStatus {
    /** The folder that was measured (null = none could be worked out). */
    path: string | null;
    freeBytes: number | null;
    totalBytes: number | null;
    /** A network folder: its free space is not asked for. */
    network: boolean;
    /** Why there are no numbers: an error code of the shell (`DISK_ERRORS`), or null. */
    error: string | null;
}

/**
 * Error codes of the shell's disk answer (`sys::err` in src-tauri/src/gig.rs; contract.test.ts
 * compares the two lists). The UI words each one (`gig.diskErr.<code>`); anything else (the
 * English prose of a 1.7 development shell) reads as "other".
 */
export const DISK_ERRORS = ["empty", "tooLong", "nul", "relative", "device", "missing", "notFolder", "queryFailed", "timeout", "noFolder", "unsupported"] as const;
export type DiskErrorCode = (typeof DISK_ERRORS)[number] | "other";

export function diskErrorCode(error: string | null): DiskErrorCode {
    return (DISK_ERRORS as readonly string[]).includes(error ?? "") ? (error as DiskErrorCode) : "other";
}

/** The folder that was asked about is gone (or is a file): measure the default folder instead. */
export function folderGone(error: string | null): boolean {
    if (!error) return false;
    const code = diskErrorCode(error);
    // The second half reads the prose of a development shell from before the codes.
    return code === "missing" || code === "notFolder" || (code === "other" && /^folder cannot be read|^path is not a folder/.test(error));
}

/** Short name of where `path` lives: the drive on Windows ("D:"), else the path itself, cut. */
export function volumeLabel(path: string | null): string {
    if (!path) return "?";
    const verbatim = /^\\\\\?\\([A-Za-z]:)/.exec(path);
    if (verbatim) return verbatim[1]!.toUpperCase();
    const drive = /^([A-Za-z]:)/.exec(path);
    if (drive) return drive[1]!.toUpperCase();
    return path.length > 28 ? path.slice(0, 27) + "\u2026" : path;
}

/**
 * `null` = the shell cannot tell (older shell, browser preview). `free` (bytes) and `minutes`
 * go to the sentence as numbers. `minutes` is never more than one recording file can hold
 * (`wavMaxMinutes`): when the disk has room for more, the sentence says the file limit
 * instead of promising the disk's room ("okCap"; "capShort" = a warning when that limit is
 * under a two-hour set, as at 96 kHz).
 */
export function classifyDisk(d: DiskStatus | null, sampleRate: number): CheckResult {
    if (!d) return give("disk.na");
    const where = volumeLabel(d.path);
    if (d.network) return give("disk.network", { where });
    if (d.error) return give("disk.error", { code: diskErrorCode(d.error) });
    if (d.freeBytes === null || d.totalBytes === null || !(d.totalBytes > 0) || d.freeBytes < 0) return give("disk.unknown");
    const room = recMinutes(d.freeBytes, sampleRate);
    const cap = wavMaxMinutes(sampleRate);
    const vars = { where, free: d.freeBytes, minutes: Math.min(room, cap) };
    if (room < SET_MINUTES_MIN) return give("disk.full", vars);
    if (room > cap) return give(cap >= SET_MINUTES ? "disk.okCap" : "disk.capShort", vars);
    return give(room >= SET_MINUTES ? "disk.ok" : "disk.short", vars);
}

// ── dropouts ──

/** Length of the dropout measurement. */
export const DROPOUT_MS = 10_000;

export interface DropoutInput {
    native: boolean;
    /** Overrun counter of the engine when the window opened / closed (it counts since the engine started and has no reset). */
    overrunsBefore: number;
    overrunsAfter: number;
    /** Highest audio load seen in the window (callback time / buffer period, 1 = the whole period). */
    peakLoad: number;
    /** A deck was playing at some point of the window. */
    playing: boolean;
}

/**
 * Levels are the status bar's own (LOAD_WARN 70 %, LOAD_ALERT 100 %). With every deck stopped
 * the load is only what the idle engine costs: a clean result then says so instead of
 * promising anything about a full mix.
 */
export function classifyDropouts(i: DropoutInput): CheckResult {
    if (!i.native) return give("dropouts.na");
    const lost = i.overrunsAfter - i.overrunsBefore;
    // The counter restarted (the engine or the output device was restarted inside the window).
    if (!Number.isFinite(lost) || lost < 0) return give("dropouts.restart");
    const pct = loadPct(i.peakLoad);
    if (lost > 0) return give("dropouts.xruns", { n: lost, pct });
    if (pct >= LOAD_ALERT) return give("dropouts.over", { pct });
    if (pct >= LOAD_WARN) return give("dropouts.high", { pct });
    return give(i.playing ? "dropouts.ok" : "dropouts.okIdle", { pct });
}

// ── library ──

/** "notLocal" = not known to be this computer (it may still be: only the text is compared). */
export type HostKind = "local" | "notLocal" | "unknown";

const bare = (host: string) => host.trim().toLowerCase().replace(/^\[|\]$/g, "");

/**
 * Is the server address this computer? Decided from the text of the address only (nothing is
 * resolved or probed): loopback (`127.x.x.x`, `localhost`, `::1`), or equal to an address this
 * computer is known to have (`selfHosts`: the LAN address the Connect server reports while it
 * runs). Anything else is "notLocal", which is all that can honestly be said about it.
 */
export function hostKind(baseUrl: string, selfHosts: readonly (string | null | undefined)[] = []): HostKind {
    let host: string;
    try {
        host = bare(new URL(baseUrl).hostname);
    } catch {
        return "unknown";
    }
    if (!host) return "unknown";
    if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)) return "local";
    if (selfHosts.some((s) => typeof s === "string" && s.trim() !== "" && bare(s) === host)) return "local";
    return "notLocal";
}

export function hostOf(baseUrl: string): string {
    try {
        return new URL(baseUrl).hostname;
    } catch {
        return "?";
    }
}

export interface LibraryInput {
    native: boolean;
    /** Answer of the companion probe; null = no answer. */
    status: { online: boolean; authed: boolean } | null;
    /** Tracks the library panel holds, the query it was fetched with, and the companion's total for it. */
    loaded: number;
    query: string;
    total: number;
    /**
     * The library panel has stored a result of the server (library/pool-store). False while the
     * panel is not shown (stage mode, the local-files source) or before its first answer: the
     * pool is empty then, and that says nothing about the library.
     */
    fetched: boolean;
    baseUrl: string;
    /** Addresses this computer is known to have (see `hostKind`). */
    selfHosts?: readonly (string | null | undefined)[];
}

export function classifyLibrary(i: LibraryInput): CheckResult {
    if (!i.native) return give("library.preview");
    if (!i.status?.online) return give("library.offline");
    if (!i.status.authed) return give("library.unpaired");
    const whole = i.query.trim() === "";
    // The server answered the whole-library question with nothing (not a search that found
    // nothing, and not a panel that never asked).
    if (i.fetched && whole && i.loaded === 0 && i.total === 0) return give("library.none");
    if (hostKind(i.baseUrl, i.selfHosts) === "notLocal") return give("library.okNotLocal", { host: clip(hostOf(i.baseUrl), DEVICE_MAX) });
    if (!i.fetched) return give("library.okUnknown");
    const n = whole ? Math.max(i.total, i.loaded) : 0;
    return n > 0 ? give("library.okCount", { n }) : give("library.ok");
}

// ── controller (information only: never a warning) ──

export interface ControllerInput {
    native: boolean;
    /** Bluetooth MIDI controller and whether it is connected. */
    ble: { name: string | null; connected: boolean } | null;
    /** MIDI input ports the system lists. */
    midiPorts: readonly string[] | null;
}

export function classifyController(i: ControllerInput): CheckResult {
    if (!i.native) return give("controller.preview");
    if (i.ble?.connected && i.ble.name) return give("controller.ble", { name: clip(i.ble.name, DEVICE_MAX) });
    const ports = (i.midiPorts ?? []).filter((p) => typeof p === "string" && p.trim().length > 0);
    if (ports.length > 0) return give(ports.length > 1 ? "controller.midiMore" : "controller.midi", { name: clip(ports[0]!, DEVICE_MAX) });
    return give("controller.none");
}

/** Checks that are not ok (and not merely unknown), in checklist order: what the DJ should look at before locking. */
export function notOk(results: Partial<Record<CheckId, CheckResult>>): CheckId[] {
    return CHECK_IDS.filter((id) => results[id]?.state === "warn" || results[id]?.state === "problem");
}

/** The parent folder of a file path (`C:\sets\a.wav` -> `C:\sets`), for the disk check. Null when there is none. */
export function folderOf(file: string | null | undefined): string | null {
    if (typeof file !== "string") return null;
    const cut = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
    if (cut < 0) return null;
    // "C:\x.wav" -> "C:\", "/x.wav" -> "/".
    const dir = file.slice(0, cut);
    if (dir === "" || /^[A-Za-z]:$/.test(dir)) return file.slice(0, cut + 1);
    return dir;
}

/** "23.0 GB" / "512 MB" (binary units, one decimal from 10 GB down). */
export function formatBytes(n: number, locale: string): string {
    const gb = n / 1024 ** 3;
    const fmt = (v: number, digits: number) => new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
    if (gb >= 1024) return `${fmt(gb / 1024, 1)} TB`;
    if (gb >= 100) return `${fmt(gb, 0)} GB`;
    if (gb >= 1) return `${fmt(gb, 1)} GB`;
    return `${fmt(Math.max(0, n) / 1024 ** 2, 0)} MB`;
}

// ─── 5. what the shell answers ───────────────────────────────────────────────

/** Keep-awake as the shell reports it. */
export type KeepAwake = "on" | "off" | "unsupported" | "failed";
const KEEP_AWAKE: readonly string[] = ["on", "off", "unsupported", "failed"];

export interface GigShell {
    locked: boolean;
    keepAwake: KeepAwake;
}

export function parseShell(v: unknown): GigShell | null {
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.locked !== "boolean" || typeof o.keepAwake !== "string" || !KEEP_AWAKE.includes(o.keepAwake)) return null;
    return { locked: o.locked, keepAwake: o.keepAwake as KeepAwake };
}

const bytes = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export interface GigSystemStatus {
    power: PowerStatus;
    disk: DiskStatus;
}

export function parseSystem(v: unknown): GigSystemStatus | null {
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    const p = o.power as Record<string, unknown> | null | undefined;
    const d = o.disk as Record<string, unknown> | null | undefined;
    if (typeof p !== "object" || p === null || typeof d !== "object" || d === null) return null;
    const source: PowerSource = p.source === "mains" || p.source === "battery" ? p.source : "unknown";
    const pct = typeof p.percent === "number" && Number.isFinite(p.percent) && p.percent >= 0 && p.percent <= 100 ? Math.round(p.percent) : null;
    return {
        power: { source, percent: pct, charging: typeof p.charging === "boolean" ? p.charging : null },
        disk: {
            path: typeof d.path === "string" ? d.path : null,
            freeBytes: bytes(d.freeBytes),
            totalBytes: bytes(d.totalBytes),
            network: d.network === true,
            error: typeof d.error === "string" && d.error.length > 0 ? d.error : null,
        },
    };
}

/**
 * How the app's part of the lock stands with the shell. "na" = this shell has no gig commands
 * (an older app shell), "pending" = not asked yet, "unconfirmed" = the shell has the command
 * but did not confirm the lock after every retry: keep-awake and the close question may be off.
 */
export type ShellLink = KeepAwake | "na" | "pending" | "unconfirmed";

/**
 * A rejected shell call, sorted: "old" = this shell has no such command (an older app shell, or
 * a platform build without it), "failed" = it has, and the call went wrong.
 */
export function shellFailure(e: unknown): "old" | "failed" {
    const text = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    return /not found|not allowed|unknown command|missing required key/i.test(text) ? "old" : "failed";
}

// ─── 6. procedures with injected dependencies ────────────────────────────────

/** Waits between the tries of a failed shell sync (three tries in all, about 1.7 s). */
export const SHELL_RETRY_MS: readonly number[] = [400, 1200];

export interface ShellSyncDeps {
    /** The lock as the page has it right now. */
    locked: () => boolean;
    /** `gig_set_locked`: resolves with the shell's answer (null = no shell at all), rejects when the call fails. */
    setLocked: (locked: boolean) => Promise<unknown>;
    sleep: (ms: number) => Promise<void>;
}

/**
 * Tell the shell where the lock stands and say how that went. The newest state is what counts:
 * when the lock changes while the shell is answering, it is told again. A failed call is tried
 * again after `SHELL_RETRY_MS`; when every try failed the answer is "unconfirmed" (the lock of
 * the page holds, but the shell may not keep awake or ask before closing), or "off" when the
 * page is unlocked (nothing was being asked for).
 */
export async function runShellSync(d: ShellSyncDeps): Promise<ShellLink> {
    let failures = 0;
    for (;;) {
        const want = d.locked();
        let link: ShellLink | null = null;
        try {
            // null = no shell at all (browser preview), or an answer this app does not know.
            const shell = parseShell(await d.setLocked(want));
            link = shell ? shell.keepAwake : "na";
        } catch (e) {
            if (shellFailure(e) === "old") link = "na";
        }
        // The lock changed while the shell was answering: tell it again, with a fresh count.
        if (d.locked() !== want) {
            failures = 0;
            continue;
        }
        if (link !== null) return link;
        const wait = SHELL_RETRY_MS[failures];
        failures++;
        if (wait === undefined) return want ? "unconfirmed" : "off";
        await d.sleep(wait);
    }
}

/** How "Close anyway" ended. */
export type CloseResult = "closed" | "stopFailed" | "closeFailed";

export interface CloseDeps {
    /** The ENGINE's answer (`is_recording`): true / false, null outside the app shell. Rejects when it cannot be asked. */
    isRecording: () => Promise<boolean | null>;
    /** `stop_recording`: resolves when the WAV is complete on disk (the engine waits for its writer). */
    stopRecording: () => Promise<unknown>;
    /** `gig_close_window`. */
    closeWindow: () => Promise<unknown>;
    /** A plain window close, for a shell without `gig_close_window` (it does not hold the window either). */
    closeUnasked: () => Promise<unknown>;
}

/**
 * "Close anyway": ask the ENGINE whether a recording runs (never the page's own flag: after a
 * page reload the page does not know), stop it through the engine and wait until that is done,
 * and only then close the window.
 *   - The engine cannot be asked (it did not start, or the call failed): nothing can be
 *     recording through it, so the window closes.
 *   - The stop fails: the window is NOT closed ("stopFailed"): closing now would cut the file.
 *   - The close fails: "closeFailed". The recording is already stopped and complete; the
 *     caller keeps the question on screen and says so.
 */
export async function closeAnyway(d: CloseDeps): Promise<CloseResult> {
    let recording = false;
    try {
        recording = (await d.isRecording()) === true;
    } catch {
        recording = false;
    }
    if (recording) {
        try {
            await d.stopRecording();
        } catch {
            return "stopFailed";
        }
    }
    try {
        await d.closeWindow();
        return "closed";
    } catch (e) {
        if (shellFailure(e) !== "old") return "closeFailed";
    }
    try {
        await d.closeUnasked();
        return "closed";
    } catch {
        return "closeFailed";
    }
}

export interface LockDeps {
    /** Close the Settings modal (closing is never gated). */
    closeSettings: () => void;
    /** Switch MIDI learn off in the engine (while it is on, the controller's messages are not dispatched). */
    midiLearnOff: () => Promise<unknown> | void;
    /** Switch HID learn off (while it is on, the HID mappings are skipped). */
    hidLearnOff: () => void;
    /** End a running 30 s skin try now (back to the DJ's own skin), not by its timer later. */
    endSkinTry: () => void;
}

/**
 * The lock went on: close Settings and switch off every mode it left running. One failing
 * step never stops the others. Returns the steps that threw, for a test or a log.
 * (The skin editor and the layout editor close themselves: each watches the lock where its
 * own state lives, settings/skin-editor/store.ts and layout/LayoutEditor.tsx.)
 */
export function enforceLock(d: LockDeps): string[] {
    const failed: string[] = [];
    const steps: [string, () => Promise<unknown> | void][] = [
        ["closeSettings", d.closeSettings],
        ["midiLearnOff", d.midiLearnOff],
        ["hidLearnOff", d.hidLearnOff],
        ["endSkinTry", d.endSkinTry],
    ];
    for (const [name, run] of steps) {
        try {
            const p = run();
            // An engine call that rejects later (old shell, engine down) is not ours to report.
            if (p && typeof (p as Promise<unknown>).catch === "function") void (p as Promise<unknown>).catch(() => undefined);
        } catch {
            failed.push(name);
        }
    }
    return failed;
}
