import Foundation

/// MixAI Live control protocol v1 (`docs/live/remote-protocol.md`). Types mirror the serde forms of
/// `live_engine::session::SessionState` & co. Decoding is lenient: unknown fields and message types are ignored
/// (forward compatible, as the spec requires) and non-finite numbers that serde writes as `null` become 0.
public enum LiveProtocol {
    /// Highest protocol version this client understands.
    public static let version = 1
    public static let defaultPort = 17920
    public static let bonjourType = "_mixai-live._tcp"
    public static let pairScheme = "mixai-live"
}

public enum Role: String, Codable, Sendable, Comparable, CaseIterable {
    case viewer, performer, controller

    private var rank: Int { switch self { case .viewer: 0; case .performer: 1; case .controller: 2 } }
    public static func < (a: Role, b: Role) -> Bool { a.rank < b.rank }

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Role(rawValue: raw) ?? .viewer
    }
}

// MARK: - Session state

public struct InsertParam: Codable, Sendable, Equatable {
    public var id: String
    public var value: Float

    public init(id: String, value: Float) { self.id = id; self.value = value }

    /// serde writes `(String, f32)` tuples as two-element arrays.
    public init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        id = try c.decode(String.self)
        value = (try? c.decodeIfPresent(Float.self)) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(id)
        try c.encode(value)
    }
}

public struct InsertState: Codable, Sendable, Equatable, Identifiable {
    public var id: UInt32
    public var fx: String
    public var enabled: Bool
    public var params: [InsertParam]

    public init(id: UInt32, fx: String, enabled: Bool, params: [InsertParam]) {
        self.id = id; self.fx = fx; self.enabled = enabled; self.params = params
    }

    public func value(_ param: String) -> Float? { params.first { $0.id == param }?.value }
}

public struct MixState: Codable, Sendable, Equatable {
    public var inputDb: Float
    public var mainDb: Float
    public var monitorDb: Float
    public var monitorDry: Float
    public var bypass: Bool
    public var mute: Bool

    public init(inputDb: Float = 0, mainDb: Float = 0, monitorDb: Float = 0, monitorDry: Float = 0, bypass: Bool = false, mute: Bool = false) {
        self.inputDb = inputDb; self.mainDb = mainDb; self.monitorDb = monitorDb; self.monitorDry = monitorDry
        self.bypass = bypass; self.mute = mute
    }

    enum CodingKeys: String, CodingKey {
        case inputDb = "input_db", mainDb = "main_db", monitorDb = "monitor_db", monitorDry = "monitor_dry", bypass, mute
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inputDb = c.lenientFloat(.inputDb)
        mainDb = c.lenientFloat(.mainDb)
        monitorDb = c.lenientFloat(.monitorDb)
        monitorDry = c.lenientFloat(.monitorDry)
        bypass = (try? c.decodeIfPresent(Bool.self, forKey: .bypass)) ?? false
        mute = (try? c.decodeIfPresent(Bool.self, forKey: .mute)) ?? false
    }
}

public struct Position: Codable, Sendable, Equatable, Hashable {
    public var song: Int
    public var part: Int
    public init(song: Int, part: Int) { self.song = song; self.part = part }
}

public struct SongPart: Codable, Sendable, Equatable {
    public var name: String
    public var preset: String
    public var program: Int?
    public init(name: String, preset: String, program: Int? = nil) { self.name = name; self.preset = preset; self.program = program }
}

public struct Song: Codable, Sendable, Equatable {
    public var title: String
    public var artist: String
    public var key: String?
    public var bpm: Float?
    public var parts: [SongPart]
    public var lyrics: String?
    public var notes: String

    public init(title: String, artist: String = "", key: String? = nil, bpm: Float? = nil, parts: [SongPart], lyrics: String? = nil, notes: String = "") {
        self.title = title; self.artist = artist; self.key = key; self.bpm = bpm; self.parts = parts; self.lyrics = lyrics; self.notes = notes
    }

    enum CodingKeys: String, CodingKey { case title, artist, key, bpm, parts, lyrics, notes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decode(String.self, forKey: .title)
        artist = (try? c.decodeIfPresent(String.self, forKey: .artist)) ?? ""
        key = try? c.decodeIfPresent(String.self, forKey: .key)
        bpm = try? c.decodeIfPresent(Float.self, forKey: .bpm)
        parts = (try? c.decodeIfPresent([SongPart].self, forKey: .parts)) ?? []
        lyrics = try? c.decodeIfPresent(String.self, forKey: .lyrics)
        notes = (try? c.decodeIfPresent(String.self, forKey: .notes)) ?? ""
    }
}

public struct Setlist: Codable, Sendable, Equatable {
    public var version: Int
    public var name: String
    public var songs: [Song]

    public init(version: Int = 1, name: String, songs: [Song]) { self.version = version; self.name = name; self.songs = songs }

    enum CodingKeys: String, CodingKey { case version, name, songs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? c.decodeIfPresent(Int.self, forKey: .version)) ?? 1
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        songs = (try? c.decodeIfPresent([Song].self, forKey: .songs)) ?? []
    }
}

// MARK: - MIDI (`live_engine::midi`, see docs/live/midi.md)

public enum MidiSourceKind: String, Codable, Sendable, Equatable, Hashable, CaseIterable {
    case cc, note

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MidiSourceKind(rawValue: raw) ?? .cc
    }
}

/// What a binding listens to. `channel: nil` = any channel (omni); channels are 0 based on the wire.
public struct MidiSource: Codable, Sendable, Equatable, Hashable {
    public var kind: MidiSourceKind
    public var channel: UInt8?
    public var number: UInt8

    public init(kind: MidiSourceKind, channel: UInt8? = nil, number: UInt8) {
        self.kind = kind; self.channel = channel; self.number = number
    }

    enum CodingKeys: String, CodingKey { case kind, channel, number }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decodeIfPresent(MidiSourceKind.self, forKey: .kind)) ?? .cc
        channel = try? c.decodeIfPresent(UInt8.self, forKey: .channel)
        number = (try? c.decodeIfPresent(UInt8.self, forKey: .number)) ?? 0
    }

    /// 1 based channel for display, nil when omni.
    public var displayChannel: Int? { channel.map { Int($0) + 1 } }
}

/// Continuous mix fields a fader / expression pedal can drive.
public enum MixField: String, Codable, Sendable, Equatable, Hashable, CaseIterable {
    case inputDb = "input_db"
    case mainDb = "main_db"
    case monitorDb = "monitor_db"
    case monitorDry = "monitor_dry"
}

/// One-shot actions (note on / CC crossing 64 upwards).
public enum MidiAction: String, Codable, Sendable, Equatable, Hashable, CaseIterable {
    case next, prev
    case tapTempo = "tap_tempo"
    case panic
    case toggleBypass = "toggle_bypass"
    case toggleMute = "toggle_mute"
}

/// What a binding controls (`kind` tagged, snake_case). Parameters address the first insert of an effect kind,
/// so a binding survives a preset change.
public enum MidiTarget: Codable, Sendable, Equatable, Hashable {
    case param(fx: String, param: String)
    case enable(fx: String)
    case mix(field: MixField)
    case action(action: MidiAction)
    /// A target this app does not know: kept so binding indices (what `midi_unbind` addresses) stay correct.
    case unknown(kind: String)

    enum CodingKeys: String, CodingKey { case kind, fx, param, field, action }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
        switch kind {
        case "param":
            self = .param(fx: (try? c.decodeIfPresent(String.self, forKey: .fx)) ?? "",
                          param: (try? c.decodeIfPresent(String.self, forKey: .param)) ?? "")
        case "enable":
            self = .enable(fx: (try? c.decodeIfPresent(String.self, forKey: .fx)) ?? "")
        case "mix":
            if let f = try? c.decodeIfPresent(MixField.self, forKey: .field) { self = .mix(field: f) } else { self = .unknown(kind: kind) }
        case "action":
            if let a = try? c.decodeIfPresent(MidiAction.self, forKey: .action) { self = .action(action: a) } else { self = .unknown(kind: kind) }
        default:
            self = .unknown(kind: kind)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .param(let fx, let param):
            try c.encode("param", forKey: .kind)
            try c.encode(fx, forKey: .fx)
            try c.encode(param, forKey: .param)
        case .enable(let fx):
            try c.encode("enable", forKey: .kind)
            try c.encode(fx, forKey: .fx)
        case .mix(let field):
            try c.encode("mix", forKey: .kind)
            try c.encode(field, forKey: .field)
        case .action(let action):
            try c.encode("action", forKey: .kind)
            try c.encode(action, forKey: .action)
        case .unknown(let kind):
            try c.encode(kind, forKey: .kind)
        }
    }
}

public struct MidiBinding: Codable, Sendable, Equatable, Hashable {
    public var source: MidiSource
    public var target: MidiTarget

    public init(source: MidiSource, target: MidiTarget) { self.source = source; self.target = target }

    enum CodingKeys: String, CodingKey { case source, target }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = (try? c.decodeIfPresent(MidiSource.self, forKey: .source)) ?? MidiSource(kind: .cc, number: 0)
        target = (try? c.decodeIfPresent(MidiTarget.self, forKey: .target)) ?? .unknown(kind: "")
    }
}

/// Persisted map (`midi.json` on the engine).
public struct MidiMap: Codable, Sendable, Equatable {
    public var bindings: [MidiBinding]
    /// Program change recalls the song part with that number (default on).
    public var programChange: Bool
    /// Only listen to this channel (0..15); nil = omni.
    public var channel: UInt8?

    public init(bindings: [MidiBinding] = [], programChange: Bool = true, channel: UInt8? = nil) {
        self.bindings = bindings; self.programChange = programChange; self.channel = channel
    }

    enum CodingKeys: String, CodingKey { case bindings, programChange = "program_change", channel }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bindings = (try? c.decodeIfPresent([MidiBinding].self, forKey: .bindings)) ?? []
        programChange = (try? c.decodeIfPresent(Bool.self, forKey: .programChange)) ?? true
        channel = try? c.decodeIfPresent(UInt8.self, forKey: .channel)
    }

    /// `midi_settings` channel form: 0 = omni, 1..16.
    public var settingsChannel: Int { channel.map { Int($0) + 1 } ?? 0 }
}

/// `state.midi`: the map plus what the engine sees right now.
public struct MidiState: Codable, Sendable, Equatable {
    public var map: MidiMap
    /// Target waiting for the next CC / note (MIDI learn); nil when nothing is armed.
    public var learning: MidiTarget?
    /// Input ports the engine has open.
    public var ports: [String]
    /// Last message seen, e.g. `cc 1/64 = 100` (for the activity light).
    public var last: String?

    public init(map: MidiMap = MidiMap(), learning: MidiTarget? = nil, ports: [String] = [], last: String? = nil) {
        self.map = map; self.learning = learning; self.ports = ports; self.last = last
    }

    enum CodingKeys: String, CodingKey { case map, learning, ports, last }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        map = (try? c.decodeIfPresent(MidiMap.self, forKey: .map)) ?? MidiMap()
        learning = try? c.decodeIfPresent(MidiTarget.self, forKey: .learning)
        ports = (try? c.decodeIfPresent([String].self, forKey: .ports)) ?? []
        last = try? c.decodeIfPresent(String.self, forKey: .last)
    }

    public var isLearning: Bool { learning != nil }

    /// The source bound to this target, if any (the UI shows it next to the control).
    public func source(for target: MidiTarget) -> MidiSource? {
        map.bindings.first { $0.target == target }?.source
    }
}

public struct SessionState: Codable, Sendable, Equatable {
    public var preset: String
    public var chain: [InsertState]
    public var mix: MixState
    public var setlist: Setlist?
    public var position: Position?
    public var presets: [String]
    /// Built-in presets: they cannot be deleted, `delete_preset` reverts a modified one to factory.
    public var factoryPresets: [String]
    /// Factory presets overridden by a user copy: only these can be reverted.
    public var modifiedPresets: [String] = []
    public var bpm: Float?
    public var midi: MidiState
    public var revision: UInt64

    public init(preset: String = "", chain: [InsertState] = [], mix: MixState = MixState(), setlist: Setlist? = nil,
                position: Position? = nil, presets: [String] = [], factoryPresets: [String] = [], bpm: Float? = nil,
                midi: MidiState = MidiState(), revision: UInt64 = 0) {
        self.preset = preset; self.chain = chain; self.mix = mix; self.setlist = setlist; self.position = position
        self.presets = presets; self.factoryPresets = factoryPresets; self.bpm = bpm; self.midi = midi
        self.revision = revision
    }

    enum CodingKeys: String, CodingKey {
        case preset, chain, mix, setlist, position, presets, factoryPresets = "factory_presets"
        case modifiedPresets = "modified_presets", bpm, midi, revision
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        preset = (try? c.decodeIfPresent(String.self, forKey: .preset)) ?? ""
        chain = (try? c.decodeIfPresent([InsertState].self, forKey: .chain)) ?? []
        mix = (try? c.decodeIfPresent(MixState.self, forKey: .mix)) ?? MixState()
        setlist = try? c.decodeIfPresent(Setlist.self, forKey: .setlist)
        position = try? c.decodeIfPresent(Position.self, forKey: .position)
        presets = (try? c.decodeIfPresent([String].self, forKey: .presets)) ?? []
        factoryPresets = (try? c.decodeIfPresent([String].self, forKey: .factoryPresets)) ?? []
        modifiedPresets = (try? c.decodeIfPresent([String].self, forKey: .modifiedPresets)) ?? []
        bpm = try? c.decodeIfPresent(Float.self, forKey: .bpm)
        midi = (try? c.decodeIfPresent(MidiState.self, forKey: .midi)) ?? MidiState()
        revision = (try? c.decodeIfPresent(UInt64.self, forKey: .revision)) ?? 0
    }

    /// A built-in preset: `delete_preset` reverts it instead of removing it (and fails when it is unmodified).
    public func isFactory(_ name: String) -> Bool { factoryPresets.contains(name) }

    /// User presets can be deleted, modified factory presets reverted; unmodified factory presets neither.
    public func isRemovable(_ name: String) -> Bool { !isFactory(name) || modifiedPresets.contains(name) }

    public var currentSong: Song? {
        guard let p = position, let s = setlist, s.songs.indices.contains(p.song) else { return nil }
        return s.songs[p.song]
    }

    public var currentPart: SongPart? {
        guard let p = position, let song = currentSong, song.parts.indices.contains(p.part) else { return nil }
        return song.parts[p.part]
    }

    /// The part `next` would move to (next part of this song, else the first part of the next song).
    public var nextPart: (song: Song, part: SongPart)? {
        guard let p = position, let s = setlist, let song = currentSong else { return nil }
        if song.parts.indices.contains(p.part + 1) { return (song, song.parts[p.part + 1]) }
        var i = p.song + 1
        while s.songs.indices.contains(i) {
            if let first = s.songs[i].parts.first { return (s.songs[i], first) }
            i += 1
        }
        return nil
    }
}

// MARK: - hello / meters

/// `RunningInfo` of the audio devices (informational).
public struct RunningInfo: Codable, Sendable, Equatable {
    public var host: String
    public var input: String
    public var output: String
    public var nominalLatencyMs: Float?

    enum CodingKeys: String, CodingKey { case host, input, output, nominalLatencyMs = "nominal_latency_ms" }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        host = (try? c.decodeIfPresent(String.self, forKey: .host)) ?? ""
        input = (try? c.decodeIfPresent(String.self, forKey: .input)) ?? ""
        output = (try? c.decodeIfPresent(String.self, forKey: .output)) ?? ""
        nominalLatencyMs = try? c.decodeIfPresent(Float.self, forKey: .nominalLatencyMs)
    }
}

public struct Hello: Codable, Sendable, Equatable {
    public var protocolVersion: Int
    public var version: String
    public var role: Role
    public var engineName: String
    public var sampleRate: Int?
    public var bufferFrames: Int?
    public var client: String?
    public var devices: RunningInfo?

    public init(protocolVersion: Int = 1, version: String = "", role: Role, engineName: String, sampleRate: Int? = nil, bufferFrames: Int? = nil) {
        self.protocolVersion = protocolVersion; self.version = version; self.role = role; self.engineName = engineName
        self.sampleRate = sampleRate; self.bufferFrames = bufferFrames
    }

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol", version, role, engineName = "engine_name", sampleRate = "sample_rate"
        case bufferFrames = "buffer_frames", client, devices
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = (try? c.decodeIfPresent(Int.self, forKey: .protocolVersion)) ?? 1
        version = (try? c.decodeIfPresent(String.self, forKey: .version)) ?? ""
        role = (try? c.decodeIfPresent(Role.self, forKey: .role)) ?? .viewer
        engineName = (try? c.decodeIfPresent(String.self, forKey: .engineName)) ?? ""
        sampleRate = try? c.decodeIfPresent(Int.self, forKey: .sampleRate)
        bufferFrames = try? c.decodeIfPresent(Int.self, forKey: .bufferFrames)
        client = try? c.decodeIfPresent(String.self, forKey: .client)
        devices = try? c.decodeIfPresent(RunningInfo.self, forKey: .devices)
    }

    /// Buffer length in milliseconds, when known.
    public var bufferMs: Double? {
        guard let sr = sampleRate, let b = bufferFrames, sr > 0 else { return nil }
        return Double(b) / Double(sr) * 1000
    }
}

public struct Tune: Codable, Sendable, Equatable {
    public var freq: Float
    public var midi: Float
    public var cents: Float
    /// Target MIDI note, -1 when idle.
    public var target: Int
    public var correctionCents: Float

    public init(freq: Float, midi: Float, cents: Float, target: Int, correctionCents: Float) {
        self.freq = freq; self.midi = midi; self.cents = cents; self.target = target; self.correctionCents = correctionCents
    }

    enum CodingKeys: String, CodingKey { case freq, midi, cents, target, correctionCents = "correction_cents" }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        freq = c.lenientFloat(.freq)
        midi = c.lenientFloat(.midi)
        cents = c.lenientFloat(.cents)
        target = (try? c.decodeIfPresent(Int.self, forKey: .target)) ?? -1
        correctionCents = c.lenientFloat(.correctionCents)
    }

    /// Note to show: the correction target when active, else the sung note (nil when unvoiced).
    public var noteName: String? {
        if target >= 0 { return NoteName.name(midi: Float(target)) }
        return midi > 0 ? NoteName.name(midi: midi) : nil
    }
}

public enum LatencyProbe: Codable, Sendable, Equatable {
    case idle, running, failed
    case done(ms: Float)

    enum Keys: String, CodingKey { case doneMs = "done_ms" }

    public init(from decoder: Decoder) throws {
        if let s = try? decoder.singleValueContainer().decode(String.self) {
            switch s {
            case "running": self = .running
            case "failed": self = .failed
            default: self = .idle
            }
            return
        }
        let c = try decoder.container(keyedBy: Keys.self)
        self = .done(ms: c.lenientFloat(.doneMs))
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .idle: var c = encoder.singleValueContainer(); try c.encode("idle")
        case .running: var c = encoder.singleValueContainer(); try c.encode("running")
        case .failed: var c = encoder.singleValueContainer(); try c.encode("failed")
        case .done(let ms): var c = encoder.container(keyedBy: Keys.self); try c.encode(ms, forKey: .doneMs)
        }
    }
}

/// `meters` message: linear peak / RMS levels (0..1, can exceed 1 when clipping), gain reduction per insert (dB).
public struct Meters: Codable, Sendable, Equatable {
    public var inPeak: Float
    public var inRms: Float
    public var outPeak: [Float]
    public var outRms: [Float]
    public var gr: [Float]
    public var dspLoad: Float
    public var dspLoadMax: Float
    public var xruns: Int
    public var clipped: Bool
    public var tune: Tune?
    public var latencyProbe: LatencyProbe

    public init(inPeak: Float = 0, inRms: Float = 0, outPeak: [Float] = [0, 0], outRms: [Float] = [0, 0], gr: [Float] = [],
                dspLoad: Float = 0, dspLoadMax: Float = 0, xruns: Int = 0, clipped: Bool = false, tune: Tune? = nil,
                latencyProbe: LatencyProbe = .idle) {
        self.inPeak = inPeak; self.inRms = inRms; self.outPeak = outPeak; self.outRms = outRms; self.gr = gr
        self.dspLoad = dspLoad; self.dspLoadMax = dspLoadMax; self.xruns = xruns; self.clipped = clipped; self.tune = tune
        self.latencyProbe = latencyProbe
    }

    enum CodingKeys: String, CodingKey {
        case inPeak = "in_peak", inRms = "in_rms", outPeak = "out_peak", outRms = "out_rms", gr
        case dspLoad = "dsp_load", dspLoadMax = "dsp_load_max", xruns, clipped, tune, latencyProbe = "latency_probe"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inPeak = c.lenientFloat(.inPeak)
        inRms = c.lenientFloat(.inRms)
        outPeak = c.lenientFloats(.outPeak, count: 2)
        outRms = c.lenientFloats(.outRms, count: 2)
        gr = c.lenientFloats(.gr, count: nil)
        dspLoad = c.lenientFloat(.dspLoad)
        dspLoadMax = c.lenientFloat(.dspLoadMax)
        xruns = (try? c.decodeIfPresent(Int.self, forKey: .xruns)) ?? 0
        clipped = (try? c.decodeIfPresent(Bool.self, forKey: .clipped)) ?? false
        tune = try? c.decodeIfPresent(Tune.self, forKey: .tune)
        latencyProbe = (try? c.decodeIfPresent(LatencyProbe.self, forKey: .latencyProbe)) ?? .idle
    }

    /// `dsp_load` as a percentage (the engine sends 0..1+).
    public var dspPercent: Int { Int((dspLoad * 100).rounded()) }
}

// MARK: - /api/fx

public struct ParamSpec: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var min: Float
    public var max: Float
    public var `default`: Float
    public var unit: String
    public var curve: String
    public var choices: [String]

    public init(id: String, min: Float, max: Float, default: Float, unit: String = "none", curve: String = "linear", choices: [String] = []) {
        self.id = id; self.min = min; self.max = max; self.default = `default`; self.unit = unit; self.curve = curve; self.choices = choices
    }

    enum CodingKeys: String, CodingKey { case id, min, max, `default`, unit, curve, choices }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        min = c.lenientFloat(.min)
        max = c.lenientFloat(.max)
        `default` = c.lenientFloat(.default)
        unit = (try? c.decodeIfPresent(String.self, forKey: .unit)) ?? "none"
        curve = (try? c.decodeIfPresent(String.self, forKey: .curve)) ?? "linear"
        choices = (try? c.decodeIfPresent([String].self, forKey: .choices)) ?? []
    }

    public var isToggle: Bool { unit == "toggle" }
    public var isChoice: Bool { unit == "choice" && !choices.isEmpty }
    private var isLog: Bool { curve == "log" && min > 0 }

    public func clamp(_ v: Float) -> Float { Swift.min(Swift.max(v, min), max) }

    /// Same mapping as `live_dsp::param::ParamSpec::from_normalized`.
    public func value(norm n: Float) -> Float {
        let n = n.isFinite ? Swift.min(Swift.max(n, 0), 1) : 0
        let v = isLog ? min * pow(max / min, n) : min + (max - min) * n
        return clamp(v)
    }

    /// Same mapping as `live_dsp::param::ParamSpec::to_normalized`.
    public func norm(value v: Float) -> Float {
        let v = clamp(v)
        guard max > min else { return 0 }
        return isLog ? log(v / min) / log(max / min) : (v - min) / (max - min)
    }

    /// Display text with the unit (`-6.0 dB`, `1.2 kHz`, `120 ms`).
    public func format(_ v: Float) -> String {
        if isChoice { let i = Int(v.rounded()); return choices.indices.contains(i) ? choices[i] : "\(i)" }
        switch unit {
        case "db": return String(format: "%.1f dB", v)
        case "hz": return v >= 1000 ? String(format: "%.2f kHz", v / 1000) : String(format: "%.0f Hz", v)
        case "ms": return String(format: "%.0f ms", v)
        case "seconds": return String(format: "%.2f s", v)
        case "ratio": return String(format: "%.1f:1", v)
        case "percent": return String(format: "%.0f%%", v)
        case "semitones": return String(format: "%+.1f st", v)
        case "cents": return String(format: "%+.0f ct", v)
        case "bpm": return String(format: "%.1f BPM", v)
        case "pan": return String(format: "%+.2f", v)
        default: return String(format: "%.2f", v)
        }
    }
}

public struct FxSpec: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var params: [ParamSpec]
    public init(id: String, params: [ParamSpec]) { self.id = id; self.params = params }
    public func param(_ id: String) -> ParamSpec? { params.first { $0.id == id } }
}

public struct Health: Codable, Sendable, Equatable {
    public var ok: Bool
    public var `protocol`: Int
    public var version: String
}

// MARK: - helpers

extension KeyedDecodingContainer {
    func lenientFloat(_ key: Key) -> Float {
        guard let v = (try? decodeIfPresent(Float.self, forKey: key)) ?? nil, v.isFinite else { return 0 }
        return v
    }

    func lenientFloats(_ key: Key, count: Int?) -> [Float] {
        let raw = (try? decodeIfPresent([Float?].self, forKey: key)) ?? nil
        var out = (raw ?? []).map { v -> Float in
            guard let v, v.isFinite else { return 0 }
            return v
        }
        if let count { while out.count < count { out.append(0) } }
        return out
    }
}

public enum NoteName {
    static let names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

    /// `69` → `A4` (rounded to the nearest semitone).
    public static func name(midi: Float) -> String {
        let n = Int(midi.rounded())
        let pc = ((n % 12) + 12) % 12
        let octave = Int((Double(n) / 12).rounded(.down)) - 1
        return names[pc] + String(octave)
    }
}
