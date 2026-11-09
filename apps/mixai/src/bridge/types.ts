/**
 * Shared types that mirror the Rust `mixai-core` public API.
 *
 * Keep these in lock-step with `src-tauri/crates/mixai-core/src/state.rs`.
 * The Rust side serializes with serde using camelCase (see `#[serde(rename_all)]`).
 */

export type DeckId = "a" | "b" | "c" | "d";

export interface AudioDevice {
    id: string;
    name: string;
    /** Number of output channels the device exposes. */
    channels: number;
    /** True for the OS default output device. */
    isDefault: boolean;
}

export interface DeckState {
    id: DeckId;
    /** Loaded track id (mixai.ro / library), or null when empty. */
    trackId: string | null;
    title: string | null;
    artist: string | null;
    loaded: boolean;
    playing: boolean;
    /** Position in seconds. */
    position: number;
    /** Total duration in seconds. */
    duration: number;
    /** Detected/original BPM (0 when unknown). */
    bpm: number;
    /** Tempo multiplier applied (1.0 = original). */
    tempo: number;
    /** Key-lock (preserve pitch when changing tempo). */
    keyLock: boolean;
    /** Channel volume 0..1. */
    volume: number;
    /** EQ in dB, -26..+6. */
    eqLow: number;
    eqMid: number;
    eqHigh: number;
    /** Bipolar filter -1..+1 (LPF left, HPF right). */
    filter: number;
    /** Crossfader assignment. */
    crossfaderAssign: "a" | "thru" | "b";
    /** Pre-fader headphone cue enabled. */
    cue: boolean;
    /** VU level 0..1 (post-fader). */
    vu: number;
    /** Hot-cue positions in seconds (null = unset); 8 slots. */
    hotCues: (number | null)[];
    /** Loop currently active. */
    loopActive: boolean;
    /** Loop in-point in seconds. */
    loopStart: number;
    /** Loop out-point in seconds. */
    loopEnd: number;
    /** Beatgrid anchor: time of the first detected beat, in seconds. */
    firstBeat: number;
    /** True when separated stems are loaded for this deck. */
    hasStems: boolean;
    /** True when stem playback is active (overrides the full mix). */
    stemsActive: boolean;
    /** Per-stem gains [vocals, drums, bass, melody], 0..1.5. */
    stemGains: number[];
    /** Active FX: 0=off, 1=echo, 2=reverb. */
    fxKind: number;
    /** FX wet/dry mix 0..1. */
    fxWet: number;
    /** FX beat division (echo time): 0.25/0.5/1/2. */
    fxBeats: number;
}

export interface MixerState {
    /** Crossfader position -1 (full A) .. +1 (full B). */
    crossfader: number;
    crossfaderCurve: "linear" | "smooth" | "sharp";
    masterVolume: number;
    cueVolume: number;
    /** Master VU 0..1. */
    masterVu: number;
    decks: DeckState[];
    sampleRate: number;
    /** Estimated output latency in milliseconds. */
    latencyMs: number;
}

export interface LoadTrackRequest {
    deck: DeckId;
    /** Absolute local path OR a mixai.ro/companion URL. */
    source: string;
    trackId?: string;
    title?: string;
    artist?: string;
    bpm?: number;
}

// ─── Companion library ───────────────────────────────────────────────────────

/** Connection + auth status of the local MMO Companion. */
export interface CompanionStatus {
    online: boolean;
    version: string | null;
    hostname: string | null;
    /** True when both a device token and a user id are configured. */
    authed: boolean;
}

/** A track row from the companion library (only the fields MIXAI uses). */
export interface LibraryTrack {
    id: number;
    /** Local absolute path the audio core decodes directly. */
    filepath: string;
    filename: string;
    artist: string | null;
    title: string | null;
    bpm: number | null;
    keyCamelot: string | null;
    duration: number | null;
    genre: string | null;
    isFavorite: boolean | null;
    rating: number | null;
    /** Stem separation status: "queued" | "processing" | "ready" | "error" | null. */
    stemsStatus: string | null;
}

export interface LibraryPage {
    tracks: LibraryTrack[];
    total: number;
    page: number;
    totalPages: number;
}

/** Resolved stem paths for a track (absolute local WAV paths). */
export interface TrackStems {
    status: string | null;
    model: string | null;
    vocals: string | null;
    drums: string | null;
    bass: string | null;
    melody: string | null;
}

/** Progress of a running stem-separation job. */
export interface StemJob {
    state: string;
    progress: number;
    message: string | null;
    stems: TrackStems | null;
}

// ─── MIDI mappings ───────────────────────────────────────────────────────────

/** Semantic action a MIDI control is bound to (matches Rust `MidiAction`). */
export type MidiAction =
    | "play"
    | "cue"
    | "sync"
    | "shift"
    | "tempo-slider"
    | "volume-fader"
    | "crossfader"
    | "filter"
    | "eq-hi"
    | "eq-mid"
    | "eq-low"
    | "headphone-cue"
    | "loop-in"
    | "loop-out"
    | "reloop"
    | "loop-halve"
    | "loop-double"
    | "beatloop1"
    | "beatloop2"
    | "beatloop4"
    | "beatloop8"
    | "hotcue1"
    | "hotcue2"
    | "hotcue3"
    | "hotcue4"
    | "hotcue5"
    | "hotcue6"
    | "hotcue7"
    | "hotcue8"
    | "master-volume";

/** Whether a control is a Note (button/pad) or CC (knob/fader). */
export type MidiControlType = "note" | "cc";

/** A single MIDI binding (matches Rust `Mapping`, serde camelCase + `type`). */
export interface MidiMapping {
    /** Status byte (message type + channel), e.g. 0x90 = Note On ch1. */
    status: number;
    /** Note or CC number. */
    midino: number;
    action: MidiAction;
    /** Target deck ("a".."d") or null for master/global. */
    deck: DeckId | null;
    type: MidiControlType;
}

/** A named controller mapping preset (matches Rust `Preset`). */
export interface MidiPreset {
    name: string;
    mappings: MidiMapping[];
}

/** A discovered HID device (matches Rust `HidDeviceInfo`). */
export interface HidDeviceInfo {
    /** OS device path used to open it unambiguously. */
    path: string;
    vendorId: number;
    productId: number;
    manufacturer: string | null;
    product: string | null;
    /** True when it matches a known DJ vendor/product. */
    isDjGear: boolean;
    /** Friendly label for display. */
    label: string;
}

/** A raw HID input report (matches Rust `HidInputEvent`, event `hid://input`). */
export interface HidInputEvent {
    bytes: number[];
    hex: string;
}

// ─── WP19-05 sync / clock / beatgrid ─────────────────────────────────────────

/** Master clock source (`auto`, `internal` or a deck id). */
export type ClockSource = "auto" | "internal" | DeckId;

/** Per-deck clock view (matches Rust `DeckClock`). */
export interface DeckClock {
    id: DeckId;
    /** Audible tempo (grid × tempo fader × sync nudge). */
    bpm: number;
    /** Fractional beat number at the playhead. */
    beat: number;
    /** Position inside the bar (0..beatsPerBar) when the downbeat is known. */
    barPhase: number | null;
    keyShift: number;
    slip: boolean;
    quantize: boolean;
    syncLock: boolean;
}

/** Master clock snapshot (matches Rust `ClockState`). */
export interface ClockState {
    /** Configured source (`auto`, `internal`, `a`..`d`). */
    configured: ClockSource;
    /** Source driving the clock right now (`internal` or a deck id). */
    source: "internal" | DeckId;
    bpm: number;
    /** Fractional master beat count. */
    beat: number;
    /** `beat` modulo 1 (0..1). */
    beatPhase: number;
    /** Position in the bar (0..beatsPerBar). */
    barPhase: number | null;
    beatsPerBar: number;
    frame: number;
    sampleRate: number;
    decks: DeckClock[];
}

/** Variable-tempo anchor: source time `time` (s) is beat number `beat`. */
export interface GridAnchor {
    time: number;
    beat: number;
}

/** Per-deck beatgrid (matches Rust `mixai_core::beatgrid::BeatGrid`). */
export interface BeatGrid {
    bpm: number;
    firstBeat?: number;
    /** Beat number (from beat 0) that is a downbeat; null = unknown. */
    downbeat?: number | null;
    beatsPerBar?: number;
    anchors?: GridAnchor[];
}

/** Key-match request (matches Rust `KeyMatchReq`). Keys are 0..23 or Camelot / Open Key names. */
export interface KeyMatchRequest {
    deck: DeckId;
    key?: number;
    masterKey?: number;
    keyName?: string;
    masterKeyName?: string;
}

// ─── WP19-06 routing ─────────────────────────────────────────────────────────

/** Output mapping mode (matches Rust `OutputMode`). */
export type OutputMode = "auto" | "stereo" | "fourChannel";

/** Output routing matrix (matches Rust `RoutingConfig`). */
export interface RoutingConfig {
    mode: OutputMode;
    /** Headphone blend: 0 = cue only, 1 = master only. */
    cueMix: number;
    /** Headphone level, 0..1.5. */
    headphoneLevel: number;
    /** Split-mono on 2-channel outputs (L = cue, R = master). */
    splitMono: boolean;
    /** Booth level, 0..1.5 (0 = booth off). */
    boothLevel: number;
    masterLatencyMs: number;
    headphoneLatencyMs: number;
    boothLatencyMs: number;
}

// ─── WP19-10 FX ──────────────────────────────────────────────────────────────

export type ColorFxKind = "none" | "filter" | "phaser" | "flanger" | "noise" | "dub_echo";
export type BeatFxKind = "none" | "echo" | "reverb" | "roll" | "gate";

/** Beat FX request (matches Rust `BeatFxReq`). */
export interface BeatFxRequest {
    deck: DeckId;
    kind: BeatFxKind;
    /** Wet/dry 0..1. */
    wet: number;
    /** Beat fraction 1/32..8. */
    beats: number;
    /** Echo feedback / reverb decay / gate depth 0..1 (default 0.5). */
    feedback?: number;
}
