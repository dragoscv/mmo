// Run: cd apps/mixai; node --test src/gig/gig-core.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    BATTERY_LOW_PCT,
    BUFFER_WARN_MS,
    CHECK_IDS,
    DEVICE_MAX,
    DISK_ERRORS,
    GIG_ACTIONS,
    HIDDEN_MAX,
    HIDDEN_TEXT_MAX,
    LOCK_MAX_AGE_MS,
    LOCKED_VERDICT,
    NOTHING_SKIPPED,
    REFUSAL_NOTICE,
    REASONS,
    SET_MINUTES,
    SET_MINUTES_MIN,
    SHELL_RETRY_MS,
    SPOKEN_REFUSALS,
    UNLOCKED,
    UNLOCK_MIN_MS,
    UNLOCK_WINDOW_MS,
    classifyAudio,
    classifyController,
    classifyDisk,
    classifyDropouts,
    classifyLibrary,
    classifyPower,
    clip,
    closeAnyway,
    confirmRefusal,
    confirmUnlock,
    decide,
    diskErrorCode,
    encodeStored,
    enforceLock,
    expireUnlock,
    folderGone,
    folderOf,
    formatBytes,
    formatDecimal,
    hostKind,
    hotkeyText,
    loadStored,
    lockedTip,
    minutesText,
    notOk,
    noteHidden,
    noteKind,
    noteSkip,
    parseShell,
    parseStored,
    parseSystem,
    pushAfterPull,
    recBytesPerMinute,
    recMinutes,
    releaseFirst,
    requestUnlock,
    runShellSync,
    shellFailure,
    unlockPress,
    volumeLabel,
    wavMaxMinutes,
    type AudioInput,
    type CheckResult,
    type DiskStatus,
    type GigAction,
    type GigVerdict,
    type HiddenToast,
    type NoteKind,
    type Skipped,
} from "./gig-core.ts";
import { gigMessages } from "../i18n/messages-gig.ts";
import { LOAD_ALERT, LOAD_WARN } from "../shell/status-math.ts";

// ─── the rule ────────────────────────────────────────────────────────────────

test("unlocked, everything is allowed; locked, each action gets its own verdict", () => {
    // Written out here on purpose (not read from the table under test).
    const want: Record<GigAction, GigVerdict> = {
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
    assert.deepEqual([...GIG_ACTIONS].sort(), Object.keys(want).sort(), "the closed list of actions changed: decide what the new one gets");
    for (const a of GIG_ACTIONS) {
        assert.equal(decide(false, a), "allow", `${a} while unlocked`);
        assert.equal(decide(false, a, "popout"), "allow", `${a} while unlocked, pop-out`);
        assert.equal(decide(true, a), want[a], `${a} while locked`);
    }
    assert.deepEqual(LOCKED_VERDICT, want);
});

test("a pop-out window closes without a question, and is locked like the main one otherwise", () => {
    assert.equal(decide(true, "closeWindow", "main"), "confirm");
    assert.equal(decide(true, "closeWindow", "popout"), "allow");
    for (const a of GIG_ACTIONS) if (a !== "closeWindow") assert.equal(decide(true, a, "popout"), decide(true, a, "main"), a);
});

test("only what the DJ asked for by hand is said aloud, and each has its sentence", () => {
    // A settings change asked for through another door (command palette, shortcuts overlay, skin)
    // says the same sentence as the Settings modal itself: it IS the same refusal.
    assert.deepEqual([...SPOKEN_REFUSALS].sort(), ["changeSettings", "openSettings", "switchProfile"]);
    for (const a of SPOKEN_REFUSALS) {
        assert.equal(decide(true, a), "skip", `${a} is refused while locked`);
        const said = REFUSAL_NOTICE[a];
        assert.ok(said, `${a} is refused with a sentence`);
        for (const lang of ["en", "ro"] as const) assert.ok((gigMessages[lang] as Record<string, string>)[`gig.say.${said}`]!.length > 20, `${lang} gig.say.${said}`);
    }
    // The silent ones have no sentence of their own.
    for (const a of ["applySettings", "cloudPull", "cloudPush", "controllerLayout", "showToast"] as const) assert.equal(decide(true, a), "skip", a);
    for (const a of ["applySettings", "cloudPull", "cloudPush", "controllerLayout", "showToast"] as const) assert.equal(REFUSAL_NOTICE[a], undefined, `${a} says nothing`);
});

test("skips are counted: toasts and controller connects add up, a held cloud sync is one fact", () => {
    let s: Skipped = NOTHING_SKIPPED;
    for (let i = 0; i < 3; i++) s = noteSkip(s, "showToast");
    s = noteSkip(s, "controllerLayout");
    assert.deepEqual(s, { toasts: 3, layouts: 1, cloudPull: false, cloudPush: false });
    const pulled = noteSkip(s, "cloudPull");
    assert.equal(pulled.cloudPull, true);
    assert.equal(noteSkip(pulled, "cloudPull"), pulled, "asked again: the same object, nothing to publish");
    const pushed = noteSkip(pulled, "cloudPush");
    assert.equal(pushed.cloudPush, true);
    assert.equal(noteSkip(pushed, "cloudPush"), pushed);
    // Refusals with a sentence are not counted.
    for (const a of ["openSettings", "applySettings", "switchProfile", "closeWindow"] as const) assert.equal(noteSkip(pushed, a), pushed, a);
    assert.deepEqual(NOTHING_SKIPPED, { toasts: 0, layouts: 0, cloudPull: false, cloudPush: false }, "the start value was not touched");
});

test("a held cloud sync is released pull first; the held push goes out only when the pull changed nothing", () => {
    assert.equal(releaseFirst({ pull: true, push: true }), "pull");
    assert.equal(releaseFirst({ pull: true, push: false }), "pull");
    assert.equal(releaseFirst({ pull: false, push: true }), "push");
    assert.equal(releaseFirst({ pull: false, push: false }), null);
    assert.equal(pushAfterPull("empty", true), true, "nothing in the account yet: upload the local state");
    assert.equal(pushAfterPull("failed", true), true, "account unreachable: same as before the lock existed");
    assert.equal(pushAfterPull("applied", true), false, "never upload what was just pulled");
    assert.equal(pushAfterPull("skipped", true), false, "locked again or signed out meanwhile");
    for (const o of ["applied", "empty", "failed", "skipped"] as const) assert.equal(pushAfterPull(o, false), false, `${o}: no push was held`);
});

// ─── stored form ─────────────────────────────────────────────────────────────

test("the stored lock round-trips, and unlocking stores no time", () => {
    assert.deepEqual(parseStored(encodeStored({ locked: true, since: 1_700_000_000_123 })), { locked: true, since: 1_700_000_000_123 });
    assert.deepEqual(parseStored(encodeStored({ locked: false, since: 99 })), UNLOCKED);
    assert.equal(JSON.parse(encodeStored({ locked: false, since: 99 })).since, 0);
});

test("anything unreadable starts unlocked: a stuck lock is impossible", () => {
    const junk: (string | null | undefined)[] = [
        null,
        undefined,
        "",
        "true",
        "1",
        "null",
        "[]",
        '[{"locked":true}]',
        "{",
        '{"locked":true',
        '{"locked":"true"}',
        '{"locked":1}',
        '{"locked":null}',
        '{"Locked":true}',
        '{"v":1,"locked":false,"since":5}',
        "locked",
        "\u0000",
        `{"locked":true,"pad":"${"x".repeat(500)}"}`,
    ];
    for (const raw of junk) assert.deepEqual(parseStored(raw), UNLOCKED, String(raw).slice(0, 40));
    assert.deepEqual(parseStored(123 as unknown as string), UNLOCKED);
});

test("a stored lock survives a missing or odd time, and a newer version's extra fields", () => {
    assert.deepEqual(parseStored('{"locked":true}'), { locked: true, since: 0 });
    assert.deepEqual(parseStored('{"locked":true,"since":"yesterday"}'), { locked: true, since: 0 });
    assert.deepEqual(parseStored('{"locked":true,"since":-5}'), { locked: true, since: 0 });
    assert.deepEqual(parseStored('{"locked":true,"since":1e400}'), { locked: true, since: 0 });
    assert.deepEqual(parseStored('{"v":9,"locked":true,"since":42.9,"future":{"a":1}}'), { locked: true, since: 42 });
});

// ─── two-step unlock (fake clock) ────────────────────────────────────────────

test("unlocking needs a first step and a second one inside the window", () => {
    const t0 = 1_000_000;
    assert.equal(requestUnlock(false, t0), null, "nothing to unlock");
    const armed = requestUnlock(true, t0);
    assert.equal(armed, t0);
    // No first step = no unlock, whatever the time.
    assert.equal(confirmUnlock(true, null, t0), false);
    assert.equal(confirmUnlock(true, null, t0 + 1000), false);
    // Too soon: the same gesture (double click, bounced key).
    assert.equal(confirmUnlock(true, armed, t0), false);
    assert.equal(confirmUnlock(true, armed, t0 + UNLOCK_MIN_MS - 1), false);
    // Inside the window, both edges included.
    assert.equal(confirmUnlock(true, armed, t0 + UNLOCK_MIN_MS), true);
    assert.equal(confirmUnlock(true, armed, t0 + 2500), true);
    assert.equal(confirmUnlock(true, armed, t0 + UNLOCK_WINDOW_MS), true);
    // Too late.
    assert.equal(confirmUnlock(true, armed, t0 + UNLOCK_WINDOW_MS + 1), false);
    // The state is checked again at the second step: the lock is gone.
    assert.equal(confirmUnlock(false, armed, t0 + 2500), false);
    // A clock that went back, or is broken.
    assert.equal(confirmUnlock(true, armed, t0 - 1), false);
    assert.equal(confirmUnlock(true, armed, Number.NaN), false);
    assert.equal(requestUnlock(true, Number.NaN), null);
    assert.ok(UNLOCK_MIN_MS >= 500 && UNLOCK_WINDOW_MS >= 3000 && UNLOCK_WINDOW_MS <= 10_000, "a double click is one step; the window is a few seconds");
});

test("the first step lapses by itself", () => {
    const t0 = 50_000;
    assert.equal(expireUnlock(null, t0), null);
    assert.equal(expireUnlock(t0, t0), t0);
    assert.equal(expireUnlock(t0, t0 + UNLOCK_WINDOW_MS), t0);
    assert.equal(expireUnlock(t0, t0 + UNLOCK_WINDOW_MS + 1), null);
    assert.equal(expireUnlock(t0, t0 - 1), null, "clock went back");
});

test("the hotkey: one press never unlocks; press, wait, press does", () => {
    const since = 10_000;
    const t0 = since + 60_000;
    assert.deepEqual(unlockPress(false, null, t0, 0), { step: "idle", armed: null });
    const first = unlockPress(true, null, t0, since);
    assert.deepEqual(first, { step: "armed", armed: t0 });
    // The same gesture again (key bounce): nothing changes, the first step stands.
    assert.deepEqual(unlockPress(true, first.armed, t0 + 100, since), { step: "wait", armed: t0 });
    assert.deepEqual(unlockPress(true, first.armed, t0 + UNLOCK_MIN_MS, since), { step: "unlocked", armed: null });
    // After the window a press is a new first step, not an unlock.
    const late = t0 + UNLOCK_WINDOW_MS + 1;
    assert.deepEqual(unlockPress(true, first.armed, late, since), { step: "armed", armed: late });
    // Right after locking (the tail of the press that locked): does not even arm.
    assert.deepEqual(unlockPress(true, null, since + UNLOCK_MIN_MS - 1, since), { step: "wait", armed: null });
    assert.deepEqual(unlockPress(true, null, since + UNLOCK_MIN_MS, since), { step: "armed", armed: since + UNLOCK_MIN_MS });
    // An unknown lock time (0) never blocks arming.
    assert.equal(unlockPress(true, null, t0, 0).step, "armed");
});

// ─── checklist ───────────────────────────────────────────────────────────────

const AUDIO_OK: AudioInput = {
    native: true,
    info: { deviceId: "wasapi:1", deviceName: "Speakers (DDJ-FLX4)", sampleRate: 48000, notes: [] },
    devices: [
        { id: "wasapi:1", isDefault: false },
        { id: "wasapi:0", isDefault: true },
    ],
    latencyMs: 10,
};

test("audio: table of cases, boundaries included", () => {
    const cases: [string, Partial<AudioInput>, string][] = [
        ["browser preview", { native: false }, "audio.preview"],
        ["engine did not start", { info: null }, "audio.noEngine"],
        ["chosen device gone", { info: { ...AUDIO_OK.info!, notes: ["output device wasapi:9 not found; using the system default device"] } }, "audio.deviceMissing"],
        ["buffer refused", { info: { ...AUDIO_OK.info!, notes: ["buffer_frames 64 rejected by the device (x); using the device default buffer"] } }, "audio.fellBackBuffer"],
        // The engine's own sentence (crates/mixai-core/src/output.rs).
        ["rate refused", { info: { ...AUDIO_OK.info!, notes: ["sample_rate 96000 Hz is not supported by the device; using its default 48000 Hz"] } }, "audio.fellBackRate"],
        // A recording the engine stopped when the rate changed (engine.rs) is about the recording,
        // not about a setting the device refused.
        ["the rate changed while recording", { info: { ...AUDIO_OK.info!, notes: ["recording stopped: the sample rate changed from 48000 to 96000 Hz"] } }, "audio.recStopped"],
        ["recording stopped wins over a rate note", { info: { ...AUDIO_OK.info!, notes: ["sample_rate 96000 Hz is not supported by the device; using its default 48000 Hz", "recording stopped: the sample rate changed from 48000 to 96000 Hz"] } }, "audio.recStopped"],
        ["a note about something else", { info: { ...AUDIO_OK.info!, notes: ["something the engine said"] } }, "audio.fellBack"],
        ["blank notes are no notes", { info: { ...AUDIO_OK.info!, notes: ["", "   "] } }, "audio.ok"],
        ["device gone wins over a buffer note", { info: { ...AUDIO_OK.info!, notes: ["buffer_frames 0 is invalid; using the device default buffer", "output device x not found; using the system default device"] } }, "audio.deviceMissing"],
        ["44.1 kHz is fine", { info: { ...AUDIO_OK.info!, sampleRate: 44100 } }, "audio.ok"],
        ["just below CD rate", { info: { ...AUDIO_OK.info!, sampleRate: 44099 } }, "audio.lowRate"],
        ["32 kHz", { info: { ...AUDIO_OK.info!, sampleRate: 32000 } }, "audio.lowRate"],
        ["buffer at the limit", { latencyMs: BUFFER_WARN_MS }, "audio.ok"],
        ["buffer over the limit", { latencyMs: BUFFER_WARN_MS + 0.1 }, "audio.bigBuffer"],
        ["buffer not known yet", { latencyMs: 0 }, "audio.ok"],
        ["the system default, other outputs exist", { info: { ...AUDIO_OK.info!, deviceId: "wasapi:0" } }, "audio.okDefault"],
        ["the only output there is", { info: { ...AUDIO_OK.info!, deviceId: "wasapi:0" }, devices: [{ id: "wasapi:0", isDefault: true }] }, "audio.ok"],
        ["device list not known", { info: { ...AUDIO_OK.info!, deviceId: "wasapi:0" }, devices: null }, "audio.ok"],
    ];
    for (const [name, patch, reason] of cases) {
        const r = classifyAudio({ ...AUDIO_OK, ...patch });
        assert.equal(r.reason, reason, name);
        assert.equal(r.state, REASONS[reason as keyof typeof REASONS], name);
    }
    const ok = classifyAudio(AUDIO_OK);
    // Numbers are numbers here (the UI writes them with the decimal sign of its language:
    // `formatDecimal`, tested with the popover texts).
    assert.deepEqual(ok.vars, { device: "DDJ-FLX4", khz: 48, ms: 10 }, "the short device name of the status bar");
    assert.equal(classifyAudio({ ...AUDIO_OK, info: { ...AUDIO_OK.info!, deviceName: null } }).vars.device, "?");
    assert.equal(classifyAudio({ ...AUDIO_OK, latencyMs: 0 }).vars.ms, "?");
    // The shell's English log sentence never reaches the UI.
    const missing = classifyAudio({ ...AUDIO_OK, info: { ...AUDIO_OK.info!, notes: ["output device wasapi:9 not found; using the system default device"] } });
    assert.deepEqual(missing.vars, {});
    // A very long device name is cut, by whole characters.
    const long = classifyAudio({ ...AUDIO_OK, info: { ...AUDIO_OK.info!, deviceName: "🎧".repeat(80) } });
    assert.equal(Array.from(String(long.vars.device)).length, DEVICE_MAX);
});

test("power: mains is ok, battery a warning, low battery a problem; the boundary is exact", () => {
    const cases: [string, Parameters<typeof classifyPower>[0], string, string][] = [
        ["old shell / preview", null, "power.na", "unknown"],
        ["system did not say", { source: "unknown", percent: 80, charging: null }, "power.unknown", "unknown"],
        ["desktop", { source: "mains", percent: null, charging: null }, "power.mains", "ok"],
        ["laptop on the charger", { source: "mains", percent: 64, charging: true }, "power.mainsPct", "ok"],
        ["on the charger, nearly empty", { source: "mains", percent: 3, charging: true }, "power.mainsPct", "ok"],
        ["battery, level unknown", { source: "battery", percent: null, charging: false }, "power.battery", "warn"],
        ["battery, full", { source: "battery", percent: 100, charging: false }, "power.batteryPct", "warn"],
        ["battery, exactly at the limit", { source: "battery", percent: BATTERY_LOW_PCT, charging: false }, "power.batteryPct", "warn"],
        ["battery, one under the limit", { source: "battery", percent: BATTERY_LOW_PCT - 1, charging: false }, "power.low", "problem"],
        ["battery, empty", { source: "battery", percent: 0, charging: false }, "power.low", "problem"],
    ];
    for (const [name, input, reason, state] of cases) {
        const r = classifyPower(input);
        assert.equal(r.reason, reason, name);
        assert.equal(r.state, state, name);
    }
    assert.equal(BATTERY_LOW_PCT, 20);
    assert.deepEqual(classifyPower({ source: "battery", percent: 19, charging: false }).vars, { pct: 19 });
});

test("the recording format the disk check assumes: 32-bit float stereo", () => {
    assert.equal(recBytesPerMinute(48000), 48000 * 2 * 4 * 60);
    assert.equal(recBytesPerMinute(48000), 23_040_000);
    assert.equal(recBytesPerMinute(44100), 21_168_000);
    assert.equal(recBytesPerMinute(96000), 46_080_000);
    // A rate that makes no sense falls back to 48 kHz instead of dividing by nothing.
    for (const bad of [0, -1, Number.NaN, 100]) assert.equal(recBytesPerMinute(bad), 23_040_000, String(bad));
    assert.equal(recMinutes(23_040_000 * 90, 48000), 90);
    assert.equal(recMinutes(23_040_000 * 90 - 1, 48000), 89);
    assert.equal(recMinutes(0, 48000), 0);
    assert.equal(recMinutes(-5, 48000), 0);
});

test("disk: room for a two-hour set is ok, under half an hour is a problem; boundaries exact", () => {
    const per = recBytesPerMinute(48000);
    const disk = (freeBytes: number | null, extra: Partial<DiskStatus> = {}): DiskStatus => ({ path: "D:\\sets", freeBytes, totalBytes: 500e9, network: false, error: null, ...extra });
    const cases: [string, DiskStatus | null, string, string][] = [
        ["old shell / preview", null, "disk.na", "unknown"],
        ["network folder", disk(null, { network: true, totalBytes: null }), "disk.network", "warn"],
        ["network wins over an error", disk(null, { network: true, error: "x" }), "disk.network", "warn"],
        ["the shell could not read it", disk(null, { error: "folder cannot be read: not found", totalBytes: null }), "disk.error", "unknown"],
        ["no numbers", disk(null), "disk.unknown", "unknown"],
        ["total of zero", disk(5, { totalBytes: 0 }), "disk.unknown", "unknown"],
        ["exactly two hours", disk(per * SET_MINUTES), "disk.ok", "ok"],
        ["one byte under two hours", disk(per * SET_MINUTES - 1), "disk.short", "warn"],
        ["exactly half an hour", disk(per * SET_MINUTES_MIN), "disk.short", "warn"],
        ["one byte under half an hour", disk(per * SET_MINUTES_MIN - 1), "disk.full", "problem"],
        ["nothing free", disk(0), "disk.full", "problem"],
        // The erase head: one WAV file cannot hold more than its 32-bit length fields, whatever
        // the disk has free (3 h 06 min at 48 kHz).
        ["plenty of room, capped by one file", disk(400e9), "disk.okCap", "ok"],
        ["exactly the room one file can hold", disk(per * wavMaxMinutes(48000)), "disk.ok", "ok"],
        ["one minute more than one file can hold", disk(per * (wavMaxMinutes(48000) + 1)), "disk.okCap", "ok"],
        // 96 kHz: one file is under a two-hour set, and that is worth saying.
        ["plenty of room at 96 kHz: one file is short", disk(400e9), "disk.capShort", "warn"],
    ];
    for (const [name, input, reason, state] of cases) {
        const r = classifyDisk(input, name.includes("96 kHz") ? 96000 : 48000);
        assert.equal(r.reason, reason, name);
        assert.equal(r.state, state, name);
    }
    assert.equal(SET_MINUTES, 120);
    assert.equal(SET_MINUTES_MIN, 30);
    // The same bytes are fewer minutes at a higher rate: 96 kHz needs twice the room.
    assert.equal(classifyDisk(disk(per * SET_MINUTES), 96000).reason, "disk.short");
    const r = classifyDisk(disk(per * 45), 48000);
    assert.deepEqual(r.vars, { where: "D:", free: per * 45, minutes: 45 });
});

test("where a folder lives, and the folder of a file", () => {
    assert.equal(volumeLabel("d:\\sets\\live"), "D:");
    assert.equal(volumeLabel("\\\\?\\c:\\very\\long"), "C:");
    assert.equal(volumeLabel("/home/dj/sets"), "/home/dj/sets");
    assert.equal(volumeLabel("/" + "a".repeat(60)).length, 28);
    assert.equal(volumeLabel(null), "?");
    assert.equal(folderOf("C:\\sets\\MIXAI-set-2026.wav"), "C:\\sets");
    assert.equal(folderOf("C:\\MIXAI-set.wav"), "C:\\");
    assert.equal(folderOf("/home/dj/set.wav"), "/home/dj");
    assert.equal(folderOf("/set.wav"), "/");
    assert.equal(folderOf("C:/sets/a/b.wav"), "C:/sets/a");
    assert.equal(folderOf("set.wav"), null);
    assert.equal(folderOf(null), null);
    assert.equal(folderOf(undefined), null);
});

test("dropouts: overruns in the window are a problem; load levels are the status bar's own", () => {
    const base = { native: true, overrunsBefore: 40, overrunsAfter: 40, peakLoad: 0.2, playing: true };
    const cases: [string, Partial<typeof base>, string, string][] = [
        ["browser preview", { native: false }, "dropouts.na", "unknown"],
        ["clean while playing", {}, "dropouts.ok", "ok"],
        ["clean with the decks stopped", { playing: false }, "dropouts.okIdle", "ok"],
        ["one overrun", { overrunsAfter: 41 }, "dropouts.xruns", "problem"],
        ["overruns win over a low load", { overrunsAfter: 43, peakLoad: 0.05 }, "dropouts.xruns", "problem"],
        ["counter went back (engine restarted)", { overrunsAfter: 3 }, "dropouts.restart", "unknown"],
        ["counter is not a number", { overrunsAfter: Number.NaN }, "dropouts.restart", "unknown"],
        ["just under the warning level", { peakLoad: (LOAD_WARN - 1) / 100 }, "dropouts.ok", "ok"],
        ["at the warning level", { peakLoad: LOAD_WARN / 100 }, "dropouts.high", "warn"],
        ["just under the alert level", { peakLoad: (LOAD_ALERT - 1) / 100 }, "dropouts.high", "warn"],
        ["at the alert level", { peakLoad: LOAD_ALERT / 100 }, "dropouts.over", "problem"],
        ["far over", { peakLoad: 3 }, "dropouts.over", "problem"],
    ];
    for (const [name, patch, reason, state] of cases) {
        const r = classifyDropouts({ ...base, ...patch });
        assert.equal(r.reason, reason, name);
        assert.equal(r.state, state, name);
    }
    // Only the overruns of the window count, not the ones before it.
    assert.deepEqual(classifyDropouts({ ...base, overrunsBefore: 1000, overrunsAfter: 1003, peakLoad: 0.5 }).vars, { n: 3, pct: 50 });
    assert.equal(LOAD_WARN, 70);
    assert.equal(LOAD_ALERT, 100);
});

test("library: offline is a problem, unpaired a warning, another computer is said", () => {
    const base = {
        native: true,
        status: { online: true, authed: true },
        loaded: 11,
        query: "",
        total: 11,
        fetched: true,
        baseUrl: "http://127.0.0.1:17899",
        selfHosts: [] as (string | null | undefined)[],
    };
    const cases: [string, Partial<typeof base>, string, string][] = [
        ["browser preview", { native: false }, "library.preview", "unknown"],
        ["no answer", { status: null as unknown as typeof base.status }, "library.offline", "problem"],
        ["offline", { status: { online: false, authed: true } }, "library.offline", "problem"],
        ["not paired", { status: { online: true, authed: false } }, "library.unpaired", "warn"],
        ["empty library", { loaded: 0, total: 0 }, "library.none", "warn"],
        ["a search that found nothing is not an empty library", { loaded: 0, total: 0, query: "zzz" }, "library.ok", "ok"],
        // The panel is not shown (stage mode, the local-files source) or has not answered yet:
        // an empty pool then says nothing, and "no tracks" would be a lie.
        ["nothing fetched yet", { loaded: 0, total: 0, fetched: false }, "library.okUnknown", "ok"],
        ["nothing fetched while a search is on", { loaded: 0, total: 0, fetched: false, query: "zzz" }, "library.okUnknown", "ok"],
        // "Another computer" is more useful before a set than "the count is unknown", and it is
        // known from the address alone.
        ["not fetched and not this computer", { loaded: 0, total: 0, fetched: false, baseUrl: "http://192.168.100.63:1" }, "library.okNotLocal", "ok"],
        ["this computer", {}, "library.okCount", "ok"],
        ["localhost by name", { baseUrl: "http://localhost:17899" }, "library.okCount", "ok"],
        ["the address its own Connect server reports", { baseUrl: "http://192.168.100.63:17899", selfHosts: ["192.168.100.63"] }, "library.okCount", "ok"],
        ["another computer", { baseUrl: "http://192.168.100.63:17899" }, "library.okNotLocal", "ok"],
        ["a tunnel host", { baseUrl: "https://lib.example.org" }, "library.okNotLocal", "ok"],
    ];
    for (const [name, patch, reason, state] of cases) {
        const r = classifyLibrary({ ...base, ...patch });
        assert.equal(r.reason, reason, name);
        assert.equal(r.state, state, name);
    }
    assert.deepEqual(classifyLibrary({ ...base, loaded: 50, total: 1240 }).vars, { n: 1240 }, "the companion's total, not the page that is loaded");
    assert.deepEqual(classifyLibrary({ ...base, baseUrl: "http://192.168.100.63:17899" }).vars, { host: "192.168.100.63" });
    assert.equal(hostKind("http://127.0.0.1:17899"), "local");
    assert.equal(hostKind("http://127.9.9.9"), "local");
    assert.equal(hostKind("http://[::1]:17899"), "local");
    assert.equal(hostKind("http://localhost"), "local");
    assert.equal(hostKind("http://dj.localhost:1"), "local");
    assert.equal(hostKind("http://127.0.0.1.evil.example"), "notLocal");
    assert.equal(hostKind("http://128.0.0.1"), "notLocal");
    // Not an address at all (the URL parser refuses 1270 as an IPv4 part): never called "this computer".
    assert.equal(hostKind("http://1270.0.0.1"), "unknown");
    assert.equal(hostKind("not a url"), "unknown");
    assert.equal(hostKind(""), "unknown");
    // What the app knows this computer is called is only what its own pieces report: the LAN
    // address of the running Connect server, nothing resolved or probed.
    assert.equal(hostKind("http://192.168.100.63:17899", ["192.168.100.63"]), "local");
    assert.equal(hostKind("http://[fe80::1]:17899", ["fe80::1"]), "local");
    assert.equal(hostKind("http://192.168.1.5:17899", ["192.168.100.63", null, "  ", "localhost"]), "notLocal");
    assert.equal(hostKind("http://192.168.100.63:17899", []), "notLocal", "nothing known about this computer: said honestly");
});

test("controller: information only, never a warning", () => {
    const none = classifyController({ native: true, ble: null, midiPorts: [] });
    assert.deepEqual([none.reason, none.state], ["controller.none", "unknown"]);
    assert.equal(classifyController({ native: false, ble: null, midiPorts: null }).reason, "controller.preview");
    assert.deepEqual(classifyController({ native: true, ble: { name: "DDJ-FLX4", connected: true }, midiPorts: ["x"] }).vars, { name: "DDJ-FLX4" });
    // A remembered Bluetooth controller that is not connected does not count.
    assert.equal(classifyController({ native: true, ble: { name: "DDJ-FLX4", connected: false }, midiPorts: [] }).reason, "controller.none");
    assert.equal(classifyController({ native: true, ble: null, midiPorts: ["DDJ-400"] }).reason, "controller.midi");
    assert.equal(classifyController({ native: true, ble: null, midiPorts: ["DDJ-400", "loopMIDI"] }).reason, "controller.midiMore");
    assert.equal(classifyController({ native: true, ble: null, midiPorts: ["", "  "] }).reason, "controller.none");
    for (const [reason, state] of Object.entries(REASONS)) if (reason.startsWith("controller.")) assert.ok(state === "ok" || state === "unknown", reason);
});

test("what is not ok lists warnings and problems, in checklist order, and nothing else", () => {
    const r = (state: CheckResult["state"]): CheckResult => ({ state, reason: "x", vars: {} });
    assert.deepEqual(notOk({}), []);
    assert.deepEqual(notOk({ audio: r("ok"), power: r("unknown"), disk: r("ok") }), []);
    assert.deepEqual(notOk({ library: r("problem"), audio: r("ok"), power: r("warn"), controller: r("unknown") }), ["power", "library"]);
    assert.deepEqual(notOk(Object.fromEntries(CHECK_IDS.map((id) => [id, r("problem")]))), [...CHECK_IDS]);
});

test("every reason has its sentence, and what to do exactly for warnings and problems, in both languages", () => {
    for (const lang of ["en", "ro"] as const) {
        const m = gigMessages[lang] as Record<string, string>;
        for (const [reason, state] of Object.entries(REASONS)) {
            assert.ok(m[`gig.r.${reason}`], `${lang}: gig.r.${reason} is missing`);
            const fix = m[`gig.fix.${reason}`];
            if (state === "warn" || state === "problem") assert.ok(fix && fix.length > 15, `${lang}: gig.fix.${reason} is missing (${state})`);
            else assert.equal(fix, undefined, `${lang}: gig.fix.${reason} exists for a ${state} reason`);
        }
        // No sentence or advice without a reason behind it.
        for (const key of Object.keys(m)) {
            const hit = /^gig\.(?:r|fix)\.(.+)$/.exec(key);
            if (hit) assert.ok(hit[1]! in REASONS, `${lang}: ${key} has no reason in REASONS`);
        }
        for (const id of CHECK_IDS) assert.ok(m[`gig.check.${id}`], `${lang}: gig.check.${id}`);
        for (const s of ["ok", "warn", "problem", "unknown"]) assert.ok(m[`gig.state.${s}`], `${lang}: gig.state.${s}`);
    }
    // Every reason belongs to a check of the list.
    for (const reason of Object.keys(REASONS)) assert.ok((CHECK_IDS as readonly string[]).includes(reason.split(".")[0]!), reason);
    // The two languages are two texts (a copied English sentence would pass the parity test).
    const en = gigMessages.en as Record<string, string>;
    const ro = gigMessages.ro as Record<string, string>;
    const same = Object.keys(en).filter((k) => en[k] === ro[k] && en[k]!.length > 12);
    assert.deepEqual(same, []);
    // Romanian has its diacritics.
    assert.match(ro["gig.say.locked"]!, /[șțăâî]/);
    assert.doesNotMatch(Object.values(ro).join(" "), /[şţ]/, "cedilla forms instead of comma-below");
});

test("the variables a sentence uses are the ones its classifier gives", () => {
    const per = recBytesPerMinute(48000);
    const samples: CheckResult[] = [
        classifyAudio(AUDIO_OK),
        classifyAudio({ ...AUDIO_OK, latencyMs: 40 }),
        classifyAudio({ ...AUDIO_OK, info: { ...AUDIO_OK.info!, sampleRate: 22050 } }),
        classifyAudio({ ...AUDIO_OK, info: { ...AUDIO_OK.info!, deviceId: "wasapi:0" } }),
        classifyPower({ source: "mains", percent: 50, charging: true }),
        classifyPower({ source: "battery", percent: 50, charging: false }),
        classifyPower({ source: "battery", percent: 5, charging: false }),
        classifyDisk({ path: "D:\\s", freeBytes: null, totalBytes: null, network: true, error: null }, 48000),
        classifyDisk({ path: "D:\\s", freeBytes: null, totalBytes: null, network: false, error: "boom" }, 48000),
        classifyDropouts({ native: true, overrunsBefore: 0, overrunsAfter: 2, peakLoad: 0.5, playing: true }),
        classifyDropouts({ native: true, overrunsBefore: 0, overrunsAfter: 0, peakLoad: 0.8, playing: true }),
        classifyDropouts({ native: true, overrunsBefore: 0, overrunsAfter: 0, peakLoad: 1.2, playing: true }),
        classifyDropouts({ native: true, overrunsBefore: 0, overrunsAfter: 0, peakLoad: 0.1, playing: false }),
        classifyLibrary({ native: true, status: { online: true, authed: true }, loaded: 5, query: "", total: 5, fetched: false, baseUrl: "http://127.0.0.1:1" }),
        classifyLibrary({ native: true, status: { online: true, authed: true }, loaded: 5, query: "", total: 5, fetched: true, baseUrl: "http://127.0.0.1:1" }),
        classifyLibrary({ native: true, status: { online: true, authed: true }, loaded: 5, query: "", total: 5, fetched: true, baseUrl: "http://10.0.0.2:1" }),
        classifyController({ native: true, ble: { name: "X", connected: true }, midiPorts: null }),
        classifyController({ native: true, ble: null, midiPorts: ["A", "B"] }),
    ];
    for (const r of samples) {
        for (const lang of ["en", "ro"] as const) {
            const m = gigMessages[lang] as Record<string, string>;
            for (const key of [`gig.r.${r.reason}`, `gig.fix.${r.reason}`]) {
                const text = m[key];
                if (!text) continue;
                for (const v of text.matchAll(/\{(\w+)\}/g)) assert.ok(v[1]! in r.vars, `${lang} ${key} uses {${v[1]}}, the classifier gives ${Object.keys(r.vars).join(", ") || "nothing"}`);
            }
        }
    }
    // The disk sentences take {where} {free} {time}: `free` comes as bytes and the UI turns it into text + {time}.
    for (const free of [per * 500, per * 60, per * 5]) {
        const r = classifyDisk({ path: "D:\\s", freeBytes: free, totalBytes: 1e12, network: false, error: null }, 48000);
        assert.equal(typeof r.vars.free, "number");
        for (const lang of ["en", "ro"] as const) {
            const used = [...(gigMessages[lang] as Record<string, string>)[`gig.r.${r.reason}`]!.matchAll(/\{(\w+)\}/g)].map((v) => v[1]!).sort();
            assert.deepEqual(used, ["free", "time", "where"], `${lang} ${r.reason}`);
        }
    }
});

test("texts for the popover: bytes, recording time, clipping", () => {
    assert.equal(formatBytes(512 * 1024 ** 2, "en"), "512 MB");
    assert.equal(formatBytes(23.04 * 1024 ** 3, "en"), "23.0 GB");
    assert.equal(formatBytes(23.04 * 1024 ** 3, "ro"), "23,0 GB");
    assert.equal(formatBytes(250 * 1024 ** 3, "en"), "250 GB");
    assert.equal(formatBytes(2.5 * 1024 ** 4, "en"), "2.5 TB");
    assert.equal(formatBytes(0, "en"), "0 MB");
    assert.equal(formatBytes(-5, "en"), "0 MB");
    assert.equal(minutesText(0), "0 min");
    assert.equal(minutesText(59), "59 min");
    assert.equal(minutesText(60), "1 h 00 min");
    assert.equal(minutesText(185), "3 h 05 min");
    assert.equal(minutesText(99 * 60 + 59), "99 h 59 min");
    assert.equal(minutesText(100 * 60), "100 h");
    assert.equal(minutesText(-3), "0 min");
    assert.equal(clip("  short  ", 10), "short");
    assert.equal(clip("abcdefghij", 10), "abcdefghij");
    assert.equal(clip("abcdefghijk", 10), "abcdefghi\u2026");
    assert.equal(Array.from(clip("😀".repeat(20), 5)).length, 5, "never half an emoji");
});

// ─── what the shell answers ──────────────────────────────────────────────────

test("the shell's answers are checked before they reach the UI", () => {
    assert.deepEqual(parseShell({ locked: true, keepAwake: "on" }), { locked: true, keepAwake: "on" });
    assert.deepEqual(parseShell({ locked: false, keepAwake: "unsupported", extra: 1 }), { locked: false, keepAwake: "unsupported" });
    for (const bad of [null, undefined, "on", 5, {}, { locked: "yes", keepAwake: "on" }, { locked: true }, { locked: true, keepAwake: "maybe" }, { locked: true, keepAwake: 1 }]) assert.equal(parseShell(bad), null, JSON.stringify(bad));

    const sys = parseSystem({ power: { source: "battery", percent: 41.6, charging: false }, disk: { path: "C:\\x", freeBytes: 10, totalBytes: 20, network: false, error: null } });
    assert.deepEqual(sys, { power: { source: "battery", percent: 42, charging: false }, disk: { path: "C:\\x", freeBytes: 10, totalBytes: 20, network: false, error: null } });
    // Odd values become "not known", never a wrong number.
    const odd = parseSystem({ power: { source: "nuclear", percent: 250, charging: "yes" }, disk: { path: 5, freeBytes: -1, totalBytes: "big", network: "true", error: "" } });
    assert.deepEqual(odd, { power: { source: "unknown", percent: null, charging: null }, disk: { path: null, freeBytes: null, totalBytes: null, network: false, error: null } });
    for (const bad of [null, undefined, 7, "x", {}, { power: {} }, { disk: {} }, { power: null, disk: {} }]) assert.equal(parseSystem(bad), null, JSON.stringify(bad));
});

test("a shell without the commands is told apart from a command that failed", () => {
    // The exact words of Tauri 2 for a command the running shell does not have.
    assert.equal(shellFailure("gig_set_locked not allowed. Command not found"), "old");
    assert.equal(shellFailure(new Error("Command gig_status not found")), "old");
    assert.equal(shellFailure("invalid args `locked` for command `gig_set_locked`: command gig_set_locked missing required key locked"), "old");
    assert.equal(shellFailure("the system refused"), "failed");
    assert.equal(shellFailure(new Error("boom")), "failed");
    assert.equal(shellFailure(undefined), "failed");
});

// ─── the lock that survives a close, and what it kept ────────────────────────

test("a stored lock older than 12 hours is dropped at start; the boundary is exact", () => {
    const now = 1_800_000_000_000;
    const storedAt = (ageMs: number) => encodeStored({ locked: true, since: now - ageMs });
    assert.equal(LOCK_MAX_AGE_MS, 12 * 60 * 60 * 1000);
    // 11 h 59: an app closed mid-set and opened again is still locked.
    const young = now - (11 * 3_600_000 + 59 * 60_000);
    assert.deepEqual(loadStored(storedAt(11 * 3_600_000 + 59 * 60_000), now), { state: { locked: true, since: young }, expired: false });
    // Exactly 12 h is not "older than 12 h"; a millisecond more is.
    assert.equal(loadStored(storedAt(12 * 3_600_000), now).expired, false);
    assert.deepEqual(loadStored(storedAt(12 * 3_600_000 + 1), now), { state: UNLOCKED, expired: true });
    // A lock with no usable time, or one in the future (the clock was set back): kept, the DJ can unlock.
    assert.deepEqual(loadStored('{"locked":true}', now), { state: { locked: true, since: 0 }, expired: false });
    const future = encodeStored({ locked: true, since: now + 60_000 });
    assert.deepEqual(loadStored(future, now), { state: { locked: true, since: now + 60_000 }, expired: false });
    // Nothing stored, or a clock that is not a number: unlocked, and nothing was dropped.
    assert.deepEqual(loadStored(null, now), { state: UNLOCKED, expired: false });
    assert.deepEqual(loadStored(storedAt(99 * 3_600_000), Number.NaN), { state: { locked: true, since: now - 99 * 3_600_000 }, expired: false });
});

test("the hidden notifications are kept, bounded and cut (in memory only)", () => {
    let list: readonly HiddenToast[] = [];
    for (let i = 1; i <= 7; i++) list = noteHidden(list, `notification ${i}`, 1000 + i);
    assert.equal(HIDDEN_MAX, 5);
    assert.deepEqual(list.map((h) => h.text), ["notification 3", "notification 4", "notification 5", "notification 6", "notification 7"]);
    assert.deepEqual(list.map((h) => h.at), [1003, 1004, 1005, 1006, 1007], "each keeps the time it was raised");
    // One line, trimmed, cut with an ellipsis; anything that is not a text is still a fact.
    assert.deepEqual(noteHidden([], "  a\n\n  b   c  ", 5), [{ text: "a b c", at: 5 }]);
    assert.equal(Array.from(noteHidden([], "x".repeat(500), 1)[0]!.text).length, HIDDEN_TEXT_MAX);
    for (const nothing of [undefined, null, 7, ""]) assert.equal(noteHidden([], nothing, 2)[0]!.text, "?", String(nothing));
    // A new array each time, so a store can tell there is a change.
    const before: readonly HiddenToast[] = [];
    assert.notEqual(noteHidden(before, "x", 1), before);
});

test("every note the engine can write is classified, and the recording one is not a refused setting", () => {
    // Read from the two files that push a note (a rewording that breaks a class fails here).
    const want: Record<NoteKind, number> = { deviceMissing: 1, recStopped: 1, buffer: 3, rate: 2, other: 1 };
    const found: Record<NoteKind, string[]> = { deviceMissing: [], recStopped: [], buffer: [], rate: [], other: [] };
    for (const raw of engineNotes()) found[noteKind(raw.replace(/\{[a-z_]*\}/gi, "1"))].push(raw);
    assert.deepEqual(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length])), want, JSON.stringify(found, null, 1));
    const withNotes = (notes: string[]) => classifyAudio({ ...AUDIO_OK, info: { ...AUDIO_OK.info!, notes } });
    assert.equal(withNotes(found.deviceMissing).reason, "audio.deviceMissing");
    assert.equal(withNotes(found.recStopped).reason, "audio.recStopped");
    assert.equal(withNotes(found.buffer).reason, "audio.fellBackBuffer");
    assert.equal(withNotes(found.rate).reason, "audio.fellBackRate");
    // A fallback whose words say nothing we know is still a fallback, not "ok".
    assert.equal(withNotes(found.other).reason, "audio.fellBack");
    // The recording sentence wins over a rate sentence of the same round: it IS about the recording.
    assert.equal(withNotes([...found.rate, ...found.recStopped]).reason, "audio.recStopped");
    assert.equal(withNotes([...found.recStopped, ...found.deviceMissing]).reason, "audio.deviceMissing", "a gone device wins: nothing plays");
});

/** Every `notes.push("...")` / `notes.push(format!("..."))` of the two engine files, as written. */
function engineNotes(): string[] {
    const out: string[] = [];
    for (const rel of ["../../src-tauri/crates/mixai-core/src/output.rs", "../../src-tauri/crates/mixai-core/src/engine.rs"]) {
        const src = readFileSync(new URL(rel, import.meta.url), "utf8");
        for (const m of src.matchAll(/notes\.push\(\s*(?:format!\(\s*)?"((?:[^"\\]|\\.)*)"/g)) out.push(m[1]!.replace(/\\"/g, '"'));
    }
    assert.ok(out.length >= 8, `only ${out.length} notes found: the engine's notes moved`);
    return out;
}

test("a Confirm that does not unlock says why", () => {
    const t0 = 1_000;
    assert.equal(confirmRefusal(false, null, t0), null, "nothing is locked: it would unlock");
    assert.equal(confirmRefusal(true, null, t0), "none", "no first step was taken");
    assert.equal(confirmRefusal(true, t0, t0 + UNLOCK_MIN_MS - 1), "early");
    assert.equal(confirmRefusal(true, t0, t0 + UNLOCK_MIN_MS), null);
    assert.equal(confirmRefusal(true, t0, t0 + UNLOCK_WINDOW_MS), null);
    assert.equal(confirmRefusal(true, t0, t0 + UNLOCK_WINDOW_MS + 1), "late");
    // A clock that went back unlocks nothing: the DJ is told to take the first step again.
    assert.equal(confirmRefusal(true, t0, t0 - 1), "late");
});

test("texts: the hotkey follows the system, a tooltip never promises a locked door, numbers use the language", () => {
    assert.equal(hotkeyText("macos"), "Cmd+Shift+G");
    assert.equal(hotkeyText("windows"), "Ctrl+Shift+G");
    assert.equal(hotkeyText("linux"), "Ctrl+Shift+G");
    // The status-bar tooltip loses its "Click for the ... settings" promise while locked.
    assert.equal(lockedTip("Click for the audio settings.", "Locked for the set"), "Locked for the set");
    assert.equal(lockedTip("Clic pentru setările audio.", "Blocat pentru set"), "Blocat pentru set");
    assert.equal(lockedTip("Click to unpair.", "Locked"), "Locked");
    // A tip that carries more than the promise keeps the rest.
    assert.equal(lockedTip("Tracks: 12. Click for the library settings.", "Locked for the set"), "Tracks: 12. Locked for the set");
    assert.equal(lockedTip("Tracks: 12.", "Locked for the set"), "Tracks: 12. Locked for the set");
    // The decimal sign of the language (the sentences carry numbers until the UI writes them).
    assert.equal(formatDecimal(48, "en"), "48.0");
    assert.equal(formatDecimal(48, "ro"), "48,0");
    assert.equal(formatDecimal(44.1, "ro"), "44,1");
});

test("a disk error is a code; only a folder that is gone asks for another folder", () => {
    for (const code of DISK_ERRORS) assert.equal(diskErrorCode(code), code);
    assert.equal(diskErrorCode(null), "other");
    assert.equal(diskErrorCode("folder cannot be read: not found"), "other", "the prose of a development shell is not a code");
    for (const code of DISK_ERRORS) assert.equal(folderGone(code), code === "missing" || code === "notFolder", code);
    // ...and the prose of the shells before the codes is understood, so nobody is sent to "unknown" for good.
    assert.equal(folderGone("folder cannot be read: the system cannot find the path"), true);
    assert.equal(folderGone("path is not a folder: D:\\x.wav"), true);
    assert.equal(folderGone("the system refused the question"), false);
    assert.equal(folderGone(null), false);
});

// ─── 6. the procedures (every outside call injected) ─────────────────────────

test("the shell is told the lock, retried a bounded number of times, and the newest state wins", async () => {
    const noSleep = async () => undefined;
    // First call fails, second answers: the lock is confirmed (and the call was retried).
    const calls: boolean[] = [];
    const link = await runShellSync({
        locked: () => true,
        setLocked: async (l) => {
            calls.push(l);
            if (calls.length < 2) throw new Error("boom");
            return { locked: l, keepAwake: "on" };
        },
        sleep: noSleep,
    });
    assert.deepEqual(calls, [true, true]);
    assert.equal(link, "on");
    // Every try fails: the answer says the shell did not confirm the lock.
    const waits: number[] = [];
    let tries = 0;
    assert.equal(
        await runShellSync({
            locked: () => true,
            setLocked: async () => {
                tries++;
                throw new Error("boom");
            },
            sleep: async (ms) => void waits.push(ms),
        }),
        "unconfirmed",
    );
    assert.equal(tries, SHELL_RETRY_MS.length + 1, "one try and one per wait: bounded");
    assert.deepEqual(waits, [...SHELL_RETRY_MS]);
    // Unlocked and no shell: nothing is being asked for.
    assert.equal(await runShellSync({ locked: () => false, setLocked: async () => { throw new Error("boom"); }, sleep: noSleep }), "off");
    // An older shell: "not available", not a failure, and not retried.
    let old = 0;
    assert.equal(
        await runShellSync({
            locked: () => true,
            setLocked: async () => {
                old++;
                throw new Error("Command gig_set_locked not found");
            },
            sleep: noSleep,
        }),
        "na",
    );
    assert.equal(old, 1);
    // No shell at all (a browser): the answer is not an object.
    assert.equal(await runShellSync({ locked: () => true, setLocked: async () => null, sleep: noSleep }), "na");
    // The lock changed while the shell was answering: it is told again, with a fresh count.
    let locked = true;
    const seen: boolean[] = [];
    const second = await runShellSync({
        locked: () => locked,
        setLocked: async (l) => {
            seen.push(l);
            if (seen.length === 1) {
                locked = false;
                throw new Error("boom");
            }
            return { locked: l, keepAwake: "off" };
        },
        sleep: noSleep,
    });
    assert.deepEqual(seen, [true, false]);
    assert.equal(second, "off");
});

test("Close anyway asks the engine, stops it, and closes only then", async () => {
    const log: string[] = [];
    const deps = (recording: boolean | null, opts: { stopFails?: boolean; closeFails?: boolean } = {}) => ({
        isRecording: async () => recording,
        stopRecording: async () => {
            log.push("stop");
            if (opts.stopFails) throw new Error("boom");
        },
        closeWindow: async () => {
            log.push("close");
            if (opts.closeFails) throw new Error("boom");
        },
        closeUnasked: async () => void log.push("unasked"),
    });
    const reset = () => (log.length = 0);
    reset();
    assert.equal(await closeAnyway(deps(true)), "closed");
    assert.deepEqual(log, ["stop", "close"], "the recording is stopped before the window goes away");
    reset();
    assert.equal(await closeAnyway(deps(false)), "closed");
    assert.deepEqual(log, ["close"], "nothing records: nothing is stopped");
    reset();
    assert.equal(await closeAnyway(deps(true, { stopFails: true })), "stopFailed");
    assert.deepEqual(log, ["stop"], "a stop that failed does NOT close: the file would be cut");
    reset();
    assert.equal(await closeAnyway(deps(true, { closeFails: true })), "closeFailed");
    assert.deepEqual(log, ["stop", "close"]);
    // The engine cannot be asked (it never started): nothing can be recording through it.
    reset();
    assert.equal(await closeAnyway({ ...deps(true), isRecording: async () => { throw new Error("no engine"); } }), "closed");
    assert.deepEqual(log, ["close"], "the question is not kept for an engine that is not there");
    // A shell without `gig_close_window` does not hold the window either: a plain close does it.
    reset();
    const old = deps(true);
    old.closeWindow = async () => {
        throw new Error("Command gig_close_window not found");
    };
    assert.equal(await closeAnyway(old), "closed");
    assert.deepEqual(log, ["stop", "unasked"]);
    // Both closes fail: the recording is safe and the answer says the window did not close.
    reset();
    const both = deps(true, { closeFails: true });
    both.closeUnasked = async () => {
        throw new Error("boom");
    };
    assert.equal(await closeAnyway(both), "closeFailed");
});

test("going locked switches off every mode Settings can leave running, and one failure stops nothing", async () => {
    const done: string[] = [];
    assert.deepEqual(
        enforceLock({
            closeSettings: () => void done.push("close"),
            midiLearnOff: async () => void done.push("midi"),
            hidLearnOff: () => void done.push("hid"),
            endSkinTry: () => void done.push("skin"),
        }),
        [],
    );
    assert.deepEqual(done, ["close", "midi", "hid", "skin"]);
    // A step that throws is reported; the others still run. A REJECTED engine call is not ours to report.
    const after: string[] = [];
    const failed = enforceLock({
        closeSettings: () => {
            throw new Error("boom");
        },
        midiLearnOff: async () => {
            after.push("midi");
            throw new Error("the engine refuses");
        },
        hidLearnOff: () => void after.push("hid"),
        endSkinTry: () => {
            throw new Error("boom");
        },
    });
    assert.deepEqual(failed, ["closeSettings", "endSkinTry"]);
    assert.deepEqual(after, ["midi", "hid"], "a later step is not skipped because an earlier one failed");
    // The rejected engine call was handled (never an unhandled rejection).
    await Promise.resolve();
});
