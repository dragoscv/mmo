/**
 * MixAI Live control protocol v1 (docs/live/remote-protocol.md): message types and a pure reducer.
 * The desktop UI uses exactly the same protocol as the phones; nothing here touches the network.
 */

export const PROTOCOL_VERSION = 1;

export type Role = "viewer" | "performer" | "controller";

export interface InsertState {
    id: number;
    fx: string;
    enabled: boolean;
    /** [param id, value] in spec order. */
    params: [string, number][];
}

export interface MixState {
    input_db: number;
    main_db: number;
    monitor_db: number;
    monitor_dry: number;
    /** Monitor option "tuned only for the audience": the ears get the chain without the pitch
     *  effects, so without the shifter's 256 samples (5.3 ms). Not persisted by the engine: a
     *  client must send it again after every restart. */
    monitor_untuned: boolean;
    bypass: boolean;
    mute: boolean;
}

export interface SongPart {
    name: string;
    preset: string;
    program?: number | null;
}

export interface Song {
    title: string;
    artist?: string;
    key?: string | null;
    bpm?: number | null;
    parts: SongPart[];
    lyrics?: string | null;
    notes?: string;
}

export interface Setlist {
    version?: number;
    name: string;
    songs: Song[];
}

export interface Position {
    song: number;
    part: number;
}

/* ── MIDI (docs/live/midi.md, serde forms of `live_engine::midi`) ──────────────────────────── */

export type MidiSourceKind = "cc" | "note";

/** What a binding listens to. `channel`: 0-based 0..15, `null`/absent = any channel (omni). */
export interface MidiSource {
    kind: MidiSourceKind;
    channel?: number | null;
    number: number;
}

/** Continuous mix fields a fader / expression pedal can drive. */
export type MixField = "input_db" | "main_db" | "monitor_db" | "monitor_dry";

/** One-shot actions (note on / CC crossing 64 upwards). */
export type MidiAction = "next" | "prev" | "tap_tempo" | "panic" | "toggle_bypass" | "toggle_mute";

/** What a binding controls (`kind`-tagged enum; params address the first insert of an effect kind). */
export type MidiTarget =
    | { kind: "param"; fx: string; param: string }
    | { kind: "enable"; fx: string }
    | { kind: "mix"; field: MixField }
    | { kind: "action"; action: MidiAction };

export interface MidiBinding {
    source: MidiSource;
    target: MidiTarget;
}

/** Persisted map (`midi.json`). */
export interface MidiMap {
    bindings: MidiBinding[];
    program_change: boolean;
    /** Listen only to this channel (0..15); `null` = omni. */
    channel?: number | null;
}

export interface MidiState {
    map: MidiMap;
    /** Target waiting for the next CC / note (MIDI learn), `null` when idle. */
    learning: MidiTarget | null;
    /** Input ports the engine has open. */
    ports: string[];
    /** Last message seen, e.g. `"cc 1/64 = 100"`. */
    last: string | null;
}

export interface SessionState {
    preset: string;
    chain: InsertState[];
    mix: MixState;
    setlist: Setlist | null;
    position: Position | null;
    presets: string[];
    /** Built-in preset names (engines before 0.1.0+midi omit this). */
    factory_presets?: string[];
    /** Factory presets overridden by a user copy (engine 0.1.0+midi); only these can be reverted. */
    modified_presets?: string[];
    bpm: number | null;
    /** MIDI map, learn target, open ports, last message (omitted by older engines). */
    midi?: MidiState;
    revision: number;
}

export interface Tune {
    freq: number;
    midi: number;
    cents: number;
    target: number;
    correction_cents: number;
}

export type LatencyProbe = "idle" | "running" | "failed" | { done_ms: number };

export interface Meters {
    in_peak: number;
    in_rms: number;
    out_peak: [number, number];
    out_rms: [number, number];
    gr: number[];
    dsp_load: number;
    dsp_load_max: number;
    xruns: number;
    clipped: boolean;
    tune: Tune | null;
    latency_probe: LatencyProbe;
    chain_latency_samples?: number;
    /** Latency of the chain the ears hear: equal to `chain_latency_samples` while
     *  `mix.monitor_untuned` is off. */
    monitor_chain_latency_samples?: number;
}

export interface RunningInfo {
    host: string;
    input: string;
    output: string;
    sample_rate: number;
    buffer_frames: number;
    input_channels: number;
    output_channels: number;
    nominal_latency_ms: number;
    notes: string[];
}

export interface Hello {
    protocol: number;
    version: string;
    role: Role;
    engine_name: string;
    sample_rate?: number;
    buffer_frames?: number;
    devices?: RunningInfo;
}

export type ServerMsg =
    | ({ type: "hello" } & Hello)
    | { type: "state"; state: SessionState }
    | ({ type: "meters" } & Meters)
    | { type: "ack"; id: number | null }
    | { type: "error"; id?: number | null; code: string; message: string }
    | { type: "pong"; t: unknown };

export type MixPatch = Partial<MixState>;

export type ClientMsg =
    | { type: "subscribe"; meters: boolean; meters_hz?: number }
    | { type: "set_param"; insert: number; param: string; value: number }
    | { type: "set_param_norm"; insert: number; param: string; norm: number }
    | { type: "set_enabled"; insert: number; on: boolean }
    | { type: "add_insert"; fx: string; at: number }
    | { type: "remove_insert"; insert: number }
    | { type: "move_insert"; insert: number; to: number }
    | { type: "load_preset"; name: string }
    | { type: "save_preset"; name: string }
    | { type: "delete_preset"; name: string }
    | ({ type: "set_mix" } & MixPatch)
    | { type: "load_setlist"; setlist: Setlist }
    | { type: "goto"; song: number; part: number }
    | { type: "next" }
    | { type: "prev" }
    | { type: "tap_tempo" }
    | { type: "panic" }
    | { type: "latency_probe" }
    | { type: "midi_learn"; target: MidiTarget | null }
    | { type: "midi_unbind"; index: number }
    | { type: "midi_settings"; program_change?: boolean; channel?: number }
    | { type: "ping"; t: number };

/* ── Client message builders for the MIDI / preset controls ───────────────────────────────── */

/** Delete a user preset (a modified factory preset reverts; an unmodified one → `factory_preset`). */
export function deletePreset(name: string): ClientMsg {
    return { type: "delete_preset", name };
}

/** Arm MIDI learn for `target`; `null` cancels the pending learn. */
export function midiLearn(target: MidiTarget | null): ClientMsg {
    return { type: "midi_learn", target };
}

/** Remove the binding at `index` in `state.midi.map.bindings`. */
export function midiUnbind(index: number): ClientMsg {
    return { type: "midi_unbind", index: Math.max(0, Math.trunc(index)) };
}

/**
 * Change MIDI settings. `channel` is the wire form: 0 = omni, 1..16 = that channel
 * (the map stores it 0-based, so `state.midi.map.channel` is one lower).
 */
export function midiSettings(patch: { program_change?: boolean; channel?: number }): ClientMsg {
    return {
        type: "midi_settings",
        ...(patch.program_change === undefined ? {} : { program_change: patch.program_change }),
        ...(patch.channel === undefined ? {} : { channel: Math.min(16, Math.max(0, Math.trunc(patch.channel))) }),
    };
}

/** Wire channel (0 = omni, 1..16) from the 0-based map channel. */
export function wireChannel(mapChannel: number | null | undefined): number {
    return mapChannel == null ? 0 : mapChannel + 1;
}

/** Stable key for a target, so UI controls can tell "is this the one being learned?". */
export function targetKey(target: MidiTarget): string {
    switch (target.kind) {
        case "param":
            return `param:${target.fx}:${target.param}`;
        case "enable":
            return `enable:${target.fx}`;
        case "mix":
            return `mix:${target.field}`;
        case "action":
            return `action:${target.action}`;
    }
}

/** True when `learning` is armed for exactly this target. */
export function isLearning(learning: MidiTarget | null | undefined, target: MidiTarget): boolean {
    return !!learning && targetKey(learning) === targetKey(target);
}

/** Human-readable source, e.g. `CC 80 · ch 1` / `Note 36 · omni`. */
export function sourceLabel(source: MidiSource, omni: string): string {
    const kind = source.kind === "cc" ? "CC" : "Note";
    const ch = source.channel == null ? omni : String(source.channel + 1);
    return `${kind} ${source.number} · ${ch}`;
}

const KNOWN = new Set(["hello", "state", "meters", "ack", "error", "pong"]);

/** Parse one text frame. Unknown message types return `null` (forward compatible, protocol §Versioning). */
export function parseServer(text: string): ServerMsg | null {
    let v: unknown;
    try {
        v = JSON.parse(text);
    } catch {
        return null;
    }
    if (!v || typeof v !== "object") return null;
    const type = (v as { type?: unknown }).type;
    if (typeof type !== "string" || !KNOWN.has(type)) return null;
    if (type === "state" && !isState((v as { state?: unknown }).state)) return null;
    return v as ServerMsg;
}

function isState(s: unknown): s is SessionState {
    if (!s || typeof s !== "object") return false;
    const o = s as Partial<SessionState>;
    return Array.isArray(o.chain) && !!o.mix && typeof o.revision === "number";
}

export interface ProtoError {
    id: number | null;
    code: string;
    message: string;
}

export interface ProtocolState {
    hello: Hello | null;
    state: SessionState | null;
    /** True when the engine speaks a newer protocol than this app ("update the app"). */
    incompatible: boolean;
    lastError: ProtoError | null;
    /** Ids of commands waiting for `ack`/`error`. */
    pending: number[];
}

export const initialProtocol: ProtocolState = {
    hello: null,
    state: null,
    incompatible: false,
    lastError: null,
    pending: [],
};

/** State reducer for every server message except `meters` (those bypass React, see meter-bus). */
export function reduce(s: ProtocolState, msg: ServerMsg): ProtocolState {
    switch (msg.type) {
        case "hello": {
            const { type: _t, ...hello } = msg;
            return { ...s, hello, incompatible: hello.protocol > PROTOCOL_VERSION };
        }
        case "state":
            // Never go back in time: an optimistic local edit carries the same revision until confirmed.
            if (s.state && msg.state.revision < s.state.revision) return s;
            return { ...s, state: msg.state };
        case "ack":
            return msg.id == null ? s : { ...s, pending: s.pending.filter((p) => p !== msg.id) };
        case "error": {
            const id = msg.id ?? null;
            return {
                ...s,
                lastError: { id, code: msg.code, message: msg.message },
                pending: id == null ? s.pending : s.pending.filter((p) => p !== id),
            };
        }
        default:
            return s;
    }
}

/** Register a sent command id. */
export function trackPending(s: ProtocolState, id: number): ProtocolState {
    return { ...s, pending: [...s.pending, id] };
}

/**
 * Apply a client intent locally so faders and toggles respond at once; the next `state` from the
 * engine (always a higher revision after a change) replaces it.
 */
export function applyOptimistic(state: SessionState | null, msg: ClientMsg): SessionState | null {
    if (!state) return state;
    switch (msg.type) {
        case "set_param":
            return {
                ...state,
                chain: state.chain.map((ins) =>
                    ins.id === msg.insert
                        ? { ...ins, params: ins.params.map(([id, v]) => [id, id === msg.param ? msg.value : v] as [string, number]) }
                        : ins,
                ),
            };
        case "set_enabled":
            return { ...state, chain: state.chain.map((ins) => (ins.id === msg.insert ? { ...ins, enabled: msg.on } : ins)) };
        case "set_mix": {
            const { type: _t, ...patch } = msg;
            return { ...state, mix: { ...state.mix, ...patch } };
        }
        case "move_insert":
            return { ...state, chain: moveItem(state.chain, (i) => i.id === msg.insert, msg.to) };
        case "remove_insert":
            return { ...state, chain: state.chain.filter((i) => i.id !== msg.insert) };
        default:
            return state;
    }
}

/** Move the first matching item to index `to` (clamped), like `Session::move_insert`. */
export function moveItem<T>(list: T[], match: (t: T) => boolean, to: number): T[] {
    const i = list.findIndex(match);
    if (i < 0) return list;
    const out = list.slice();
    const [item] = out.splice(i, 1);
    out.splice(Math.max(0, Math.min(to, out.length)), 0, item as T);
    return out;
}

/** Current song/part from state, if a setlist is loaded. */
export function currentPart(state: SessionState | null): { song: Song; part: SongPart; pos: Position } | null {
    const sl = state?.setlist;
    const pos = state?.position;
    if (!sl || !pos) return null;
    const song = sl.songs[pos.song];
    const part = song?.parts[pos.part];
    return song && part ? { song, part, pos } : null;
}

/** Light structural validation of a user-picked setlist file before sending it. */
export function parseSetlist(text: string): Setlist | null {
    let v: unknown;
    try {
        v = JSON.parse(text);
    } catch {
        return null;
    }
    if (!v || typeof v !== "object") return null;
    const o = v as Partial<Setlist>;
    if (typeof o.name !== "string" || !Array.isArray(o.songs) || o.songs.length === 0) return null;
    for (const s of o.songs) {
        if (!s || typeof s.title !== "string" || !Array.isArray(s.parts) || s.parts.length === 0) return null;
        for (const p of s.parts) if (!p || typeof p.name !== "string" || typeof p.preset !== "string") return null;
    }
    return o as Setlist;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** MIDI note number to a name like "A4". */
export function noteName(midi: number): string {
    if (!Number.isFinite(midi) || midi < 0) return "–";
    const n = Math.round(midi);
    return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** Linear amplitude to dBFS (floor -90). */
export function linToDb(x: number): number {
    return x > 0 ? Math.max(-90, 20 * Math.log10(x)) : -90;
}
