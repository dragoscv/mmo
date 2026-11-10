/**
 * Typed wrappers around the Tauri commands exposed by the Rust audio core.
 *
 * Every function here corresponds 1:1 to a `#[tauri::command]` in
 * `src-tauri/src/lib.rs`. The UI never calls `invoke` directly — it goes
 * through these so the command names and argument shapes stay in one place.
 *
 * When running outside Tauri (plain `vite` / Storybook), `invoke` is absent;
 * we degrade to a no-op mock so the UI still renders for design work.
 */

import type {
    AudioDevice,
    DeckId,
    LoadTrackRequest,
    MixerState,
} from "./types";
import type {
    CompanionStatus,
    LibraryPage,
    StemJob,
    TrackStems,
} from "./types";
import type { BleMidiDevice, HidDeviceInfo, MidiPreset } from "./types";
import type {
    BeatFxRequest,
    BeatGrid,
    ClockSource,
    ClockState,
    ColorFxKind,
    KeyMatchRequest,
    OutputInfo,
    RoutingConfig,
    TempoMarker,
} from "./types";
// Relative + explicit extension so `node --test` can load this module without the Vite alias.
import { resetDeckGrid, setGridBridge } from "../grid/grid-store.ts";
import { gridFromDeck } from "../grid/markers.ts";

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeImpl: InvokeFn | null = null;

async function getInvoke(): Promise<InvokeFn | null> {
    if (invokeImpl) return invokeImpl;
    // Tauri injects `__TAURI_INTERNALS__`; in a plain browser it's undefined.
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        const mod = await import("@tauri-apps/api/core");
        invokeImpl = mod.invoke as InvokeFn;
        return invokeImpl;
    }
    return null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    const invoke = await getInvoke();
    if (!invoke) {
        // Design-mode mock: log and return null so the UI keeps working.
        // `?.` so the module also loads outside Vite (node --test covers the load paths).
        if (import.meta.env?.DEV) console.debug(`[mixai mock] ${cmd}`, args ?? {});
        return null;
    }
    return invoke<T>(cmd, args);
}

export const engine = {
    /** True when running inside the Tauri shell (audio core available). */
    async isNative(): Promise<boolean> {
        return (await getInvoke()) !== null;
    },

    listAudioDevices(): Promise<AudioDevice[] | null> {
        return call<AudioDevice[]>("list_audio_devices");
    },

    /** Switch the output device ("" = system default); returns what was actually opened (+ fallback notes). */
    setOutputDevice(deviceId: string): Promise<OutputInfo | null> {
        return call<OutputInfo>("set_output_device", { deviceId });
    },

    /** Opened device, sample rate, channels, buffer and latency of the running engine. */
    audioOutputInfo(): Promise<OutputInfo | null> {
        return call<OutputInfo>("audio_output_info");
    },

    /** Per-deck trim (pre-EQ), dB in −∞..+12; −96 or lower = silence. */
    setDeckTrim(deck: DeckId, db: number): Promise<null> {
        return call<null>("deck_set_trim", { deck, db });
    },

    setCueDevice(deviceId: string): Promise<null> {
        return call<null>("set_cue_device", { deviceId });
    },

    getState(): Promise<MixerState | null> {
        return call<MixerState>("get_mixer_state");
    },

    /** Loads a track and returns its downsampled waveform peaks (0..1). */
    loadTrack(req: LoadTrackRequest): Promise<number[] | null> {
        resetDeckGrid(req.deck, req.trackId ?? null, gridFromDeck(req.bpm && req.bpm > 0 ? req.bpm : 0, 0));
        return call<number[]>("load_track", { req });
    },

    /**
     * Stream a companion track's audio over HTTP (decode in-memory). Use when
     * the companion runs on another machine (LAN / tunnel) so the file isn't on
     * local disk. Returns waveform peaks like {@link loadTrack}.
     */
    loadTrackStream(req: {
        deck: DeckId;
        trackId: number;
        title?: string | null;
        artist?: string | null;
        bpm?: number | null;
    }): Promise<number[] | null> {
        resetDeckGrid(req.deck, String(req.trackId), gridFromDeck(req.bpm && req.bpm > 0 ? req.bpm : 0, 0));
        return call<number[]>("load_track_stream", { req });
    },

    play(deck: DeckId): Promise<null> {
        return call<null>("deck_play", { deck });
    },

    pause(deck: DeckId): Promise<null> {
        return call<null>("deck_pause", { deck });
    },

    seek(deck: DeckId, position: number): Promise<null> {
        return call<null>("deck_seek", { deck, position });
    },

    setVolume(deck: DeckId, value: number): Promise<null> {
        return call<null>("deck_set_volume", { deck, value });
    },

    setTempo(deck: DeckId, tempo: number): Promise<null> {
        return call<null>("deck_set_tempo", { deck, tempo });
    },

    setKeyLock(deck: DeckId, enabled: boolean): Promise<null> {
        return call<null>("deck_set_key_lock", { deck, enabled });
    },

    setEq(deck: DeckId, band: "low" | "mid" | "high", db: number): Promise<null> {
        return call<null>("deck_set_eq", { deck, band, db });
    },

    setFilter(deck: DeckId, value: number): Promise<null> {
        return call<null>("deck_set_filter", { deck, value });
    },

    setCue(deck: DeckId, enabled: boolean): Promise<null> {
        return call<null>("deck_set_cue", { deck, enabled });
    },

    setCrossfader(value: number): Promise<null> {
        return call<null>("set_crossfader", { value });
    },

    setMasterVolume(value: number): Promise<null> {
        return call<null>("set_master_volume", { value });
    },

    // ---- hot cues -------------------------------------------------------

    setHotCue(deck: DeckId, slot: number): Promise<null> {
        return call<null>("deck_set_hot_cue", { deck, slot });
    },

    jumpHotCue(deck: DeckId, slot: number): Promise<null> {
        return call<null>("deck_jump_hot_cue", { deck, slot });
    },

    clearHotCue(deck: DeckId, slot: number): Promise<null> {
        return call<null>("deck_clear_hot_cue", { deck, slot });
    },

    // ---- loops ----------------------------------------------------------

    loopIn(deck: DeckId): Promise<null> {
        return call<null>("deck_loop_in", { deck });
    },

    loopOut(deck: DeckId): Promise<null> {
        return call<null>("deck_loop_out", { deck });
    },

    loopToggle(deck: DeckId): Promise<null> {
        return call<null>("deck_loop_toggle", { deck });
    },

    loopExit(deck: DeckId): Promise<null> {
        return call<null>("deck_loop_exit", { deck });
    },

    beatloop(deck: DeckId, beats: number): Promise<null> {
        return call<null>("deck_beatloop", { deck, beats });
    },

    loopScale(deck: DeckId, factor: number): Promise<null> {
        return call<null>("deck_loop_scale", { deck, factor });
    },

    /** Match this deck's tempo to the master deck's effective BPM. */
    sync(deck: DeckId): Promise<null> {
        return call<null>("deck_sync", { deck });
    },

    // ---- MIDI -----------------------------------------------------------

    listMidiInputs(): Promise<string[] | null> {
        return call<string[]>("list_midi_inputs");
    },

    /** Connect to the first input whose name contains `name`. Returns the port. */
    async midiConnect(name: string): Promise<string | null> {
        const port = await call<string>("midi_connect", { name });
        // Lets the shell apply the layout mapped to this controller.
        if (port && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("mixai:midi-connected", { detail: port }));
        return port;
    },

    midiDisconnect(): Promise<null> {
        return call<null>("midi_disconnect");
    },

    // ---- Bluetooth LE MIDI ----------------------------------------------

    bleMidiScan(seconds = 4): Promise<BleMidiDevice[] | null> {
        return call<BleMidiDevice[]>("ble_midi_scan", { seconds });
    },

    bleMidiConnect(name: string): Promise<string | null> {
        return call<string>("ble_midi_connect", { name });
    },

    /** Disconnect; `forget` also turns auto-connect off. */
    bleMidiDisconnect(forget = true): Promise<null> {
        return call<null>("ble_midi_disconnect", { forget });
    },

    /** `[device name (connected or remembered), connected]`. */
    bleMidiStatus(): Promise<[string | null, boolean] | null> {
        return call<[string | null, boolean]>("ble_midi_status");
    },

    midiSetLearn(enabled: boolean): Promise<null> {
        return call<null>("midi_set_learn", { enabled });
    },

    /** Get the active controller mapping preset (name + bindings). */
    midiGetPreset(): Promise<MidiPreset | null> {
        return call<MidiPreset>("midi_get_preset");
    },

    /** Replace the active controller mapping preset (imported / edited). */
    midiSetPreset(preset: MidiPreset): Promise<null> {
        return call<null>("midi_set_preset", { preset });
    },

    // ---- HID controllers -------------------------------------------------

    /** Enumerate connected HID devices (DJ gear first). */
    listHidDevices(): Promise<HidDeviceInfo[] | null> {
        return call<HidDeviceInfo[]>("list_hid_devices");
    },

    /** Open the HID device at `path` and stream its reports via `hid://input`. */
    hidConnect(path: string): Promise<string | null> {
        return call<string>("hid_connect", { path });
    },

    hidDisconnect(): Promise<null> {
        return call<null>("hid_disconnect");
    },

    /** Path of the currently-open HID device, or null. */
    hidOpenPath(): Promise<string | null> {
        return call<string>("hid_open_path");
    },

    /** Queue a raw HID output report (LED/feedback) to the connected device. */
    hidWriteReport(bytes: number[]): Promise<null> {
        return call<null>("hid_write_report", { bytes });
    },

    // ---- file picker ----------------------------------------------------

    /**
     * Open the native file picker for audio files. Returns the absolute path
     * or null (cancelled / non-native). Uses the Tauri dialog plugin.
     */
    async pickAudioFile(): Promise<string | null> {
        const invoke = await getInvoke();
        if (!invoke) return null;
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
            multiple: false,
            directory: false,
            filters: [
                {
                    name: "Audio",
                    extensions: ["mp3", "wav", "flac", "aac", "m4a", "ogg", "aiff", "aif"],
                },
            ],
        });
        return typeof selected === "string" ? selected : null;
    },

    // ---- recording ------------------------------------------------------

    /**
     * Prompt for a save location then start recording the master mix to WAV.
     * Returns the chosen path, or null if cancelled / non-native.
     */
    async startRecording(): Promise<string | null> {
        const invoke = await getInvoke();
        if (!invoke) return null;
        const { save } = await import("@tauri-apps/plugin-dialog");
        const stamp = new Date()
            .toISOString()
            .replace(/[:T]/g, "-")
            .replace(/\..+$/, "");
        const path = await save({
            defaultPath: `MIXAI-set-${stamp}.wav`,
            filters: [{ name: "WAV audio", extensions: ["wav"] }],
        });
        if (typeof path !== "string") return null;
        await call<null>("start_recording", { path });
        return path;
    },

    stopRecording(): Promise<null> {
        return call<null>("stop_recording");
    },

    isRecording(): Promise<boolean | null> {
        return call<boolean>("is_recording");
    },

    // ---- stems ----------------------------------------------------------

    /**
     * Decode + attach separated stems to a deck. Pass absolute local paths
     * (null/omitted layers are skipped). Returns the indices that loaded.
     */
    loadStems(
        deck: DeckId,
        stems: { vocals?: string | null; drums?: string | null; bass?: string | null; melody?: string | null },
    ): Promise<number[] | null> {
        return call<number[]>("load_stems", { req: { deck, ...stems } });
    },

    /** Toggle stem playback on a deck (keeps loaded buffers). */
    setStemsActive(deck: DeckId, on: boolean): Promise<null> {
        return call<null>("deck_set_stems_active", { deck, on });
    },

    /** Set a stem's live gain (0..1.5); idx 0=vocals,1=drums,2=bass,3=melody. */
    setStemGain(deck: DeckId, idx: number, gain: number): Promise<null> {
        return call<null>("deck_set_stem_gain", { deck, idx, gain });
    },

    // ---- FX (beat-synced echo / reverb) --------------------------------

    /** Select the active FX: 0=off, 1=echo, 2=reverb. */
    setFxKind(deck: DeckId, kind: number): Promise<null> {
        return call<null>("deck_set_fx_kind", { deck, kind });
    },

    /** Set the FX wet/dry mix (0..1). */
    setFxWet(deck: DeckId, wet: number): Promise<null> {
        return call<null>("deck_set_fx_wet", { deck, wet });
    },

    /** Set the FX beat division / echo time (0.25/0.5/1/2…). */
    setFxBeats(deck: DeckId, beats: number): Promise<null> {
        return call<null>("deck_set_fx_beats", { deck, beats });
    },

    // ---- sampler (one-shot pad bank) -----------------------------------

    /** Load an audio file into a sampler pad (decoded natively). */
    samplerLoad(pad: number, path: string): Promise<null> {
        return call<null>("sampler_load", { pad, path });
    },

    /** Clear a sampler pad. */
    samplerClear(pad: number): Promise<null> {
        return call<null>("sampler_clear", { pad });
    },

    /** Trigger a sampler pad from the start. */
    samplerTrigger(pad: number): Promise<null> {
        return call<null>("sampler_trigger", { pad });
    },

    /** Stop a sampler pad immediately. */
    samplerStop(pad: number): Promise<null> {
        return call<null>("sampler_stop", { pad });
    },

    /** Set a sampler pad's gain (0..1.5). */
    samplerSetGain(pad: number, gain: number): Promise<null> {
        return call<null>("sampler_set_gain", { pad, gain });
    },

    /** Toggle one-shot vs. loop for a sampler pad. */
    samplerSetLooping(pad: number, looping: boolean): Promise<null> {
        return call<null>("sampler_set_looping", { pad, looping });
    },

    // ---- companion library ---------------------------------------------

    /** Probe the local MMO Companion (`/health`) + report auth state. */
    companionStatus(): Promise<CompanionStatus | null> {
        return call<CompanionStatus>("companion_status");
    },

    /** Set the companion base URL / device token / user id. */
    companionConfigure(cfg: {
        baseUrl?: string;
        deviceToken?: string;
        userId?: string;
    }): Promise<null> {
        return call<null>("companion_configure", cfg);
    },

    /** List tracks from the companion library. */
    companionTracks(opts?: {
        search?: string;
        page?: number;
        sort?: string;
        order?: string;
    }): Promise<LibraryPage | null> {
        return call<LibraryPage>("companion_tracks", opts ?? {});
    },

    /** Toggle a companion track's favorite flag; returns the new value. */
    companionToggleFavorite(id: number): Promise<boolean | null> {
        return call<boolean>("companion_toggle_favorite", { id });
    },

    /** Fetch a companion track's stem paths + status. */
    companionTrackStems(id: number): Promise<TrackStems | null> {
        return call<TrackStems>("companion_track_stems", { id });
    },

    /** Request stem separation for a track; returns the job id to poll. */
    companionRequestStems(id: number, model?: string): Promise<string | null> {
        return call<string | null>("companion_request_stems", { id, model });
    },

    /** Poll a stem-separation job's progress. */
    companionStemJob(jobId: string): Promise<StemJob | null> {
        return call<StemJob>("companion_stem_job", { jobId });
    },

    /** Fetch the stored MIXAI profile blob (JSON string) for the signed-in
     *  user, or null if nothing has been synced yet. */
    companionGetProfile(): Promise<string | null> {
        return call<string | null>("companion_get_profile");
    },

    /** Save the MIXAI profile blob (JSON string from `exportProfile`) to the
     *  companion, keyed by the signed-in user. */
    companionPutProfile(profile: string): Promise<null> {
        return call<null>("companion_put_profile", { profile });
    },

    // ---- WP19-05 sync / quantize / beat jump / slip / key ------------------

    /** One-shot phase + tempo sync to the master clock; `lock` keeps it locked. */
    phaseSync(deck: DeckId, lock = false): Promise<null> {
        return call<null>("deck_phase_sync", { deck, lock });
    },

    /** Continuous sync lock on/off without a one-shot alignment. */
    setSyncLock(deck: DeckId, enabled: boolean): Promise<null> {
        return call<null>("deck_set_sync_lock", { deck, enabled });
    },

    /**
     * Replace a deck's beatgrid (constant, or variable through `anchors`). Build it from
     * tempo markers with `toBeatGrid()` in `src/grid/markers.ts`; `fixed` keeps the markers
     * but makes the deck use the constant `bpm` + `firstBeat` grid (WP19-37).
     */
    setBeatgrid(deck: DeckId, grid: BeatGrid): Promise<null> {
        return call<null>("deck_set_beatgrid", { deck, grid });
    },

    /**
     * Flexible beatgrid from tempo-change markers (WP19-37). `bpm` is the tempo from
     * `firstBeat` to the first marker; `fixed` keeps the markers but plays the constant grid.
     */
    setGridMarkers(
        deck: DeckId,
        req: { bpm: number; firstBeat: number; markers: TempoMarker[]; fixed?: boolean; downbeat?: number | null },
    ): Promise<null> {
        return call<null>("deck_set_grid_markers", { req: { deck, ...req } });
    },

    setQuantize(deck: DeckId, enabled: boolean): Promise<null> {
        return call<null>("deck_set_quantize", { deck, enabled });
    },

    /** Jump by `beats` (negative = back), within ±64. */
    beatJump(deck: DeckId, beats: number): Promise<null> {
        return call<null>("deck_beat_jump", { deck, beats });
    },

    setSlip(deck: DeckId, enabled: boolean): Promise<null> {
        return call<null>("deck_set_slip", { deck, enabled });
    },

    setReverse(deck: DeckId, enabled: boolean): Promise<null> {
        return call<null>("deck_set_reverse", { deck, enabled });
    },

    /** Key shift in semitones (−12..12), independent of tempo. */
    setKeyShift(deck: DeckId, semitones: number): Promise<null> {
        return call<null>("deck_set_key_shift", { deck, semitones });
    },

    /** Key-shift `deck` to the master's key; returns the applied shift (semitones). */
    keyMatch(req: KeyMatchRequest): Promise<number | null> {
        return call<number>("deck_key_match", { req });
    },

    /** Remember a deck's key: 0..23 or a Camelot / Open Key name (null clears). */
    setDeckKey(deck: DeckId, key: { key?: number; keyName?: string } | null): Promise<null> {
        return call<null>("deck_set_key", { deck, key: key?.key ?? null, keyName: key?.keyName ?? null });
    },

    /** Master clock source and/or internal bpm (20..300). Omitted fields stay. */
    setMasterClock(opts: { source?: ClockSource; bpm?: number }): Promise<null> {
        return call<null>("master_set_clock", { source: opts.source ?? null, bpm: opts.bpm ?? null });
    },

    /** Master tempo + beat phase + per-deck beat positions (null when engine down). */
    clockState(): Promise<ClockState | null> {
        return call<ClockState | null>("engine_clock_state");
    },

    // ---- WP19-06 routing ----------------------------------------------------

    setRouting(routing: RoutingConfig): Promise<null> {
        return call<null>("routing_set", { routing });
    },

    getRouting(): Promise<RoutingConfig | null> {
        return call<RoutingConfig | null>("routing_get");
    },

    // ---- WP19-10 colour FX / beat FX ----------------------------------------

    /** Colour FX on a deck; `param` −1..1 (one knob). */
    setColorFx(deck: DeckId, kind: ColorFxKind, param: number): Promise<null> {
        return call<null>("fx_color_set", { deck, kind, param });
    },

    /** Beat FX synced to the master clock. */
    setBeatFx(req: BeatFxRequest): Promise<null> {
        return call<null>("fx_beat_set", { req });
    },
};

// The grid store pushes edits through this bridge. It is injected rather than imported there so
// `src/grid/` stays Tauri-free (and testable) and there is no import cycle with this module.
setGridBridge(engine);
