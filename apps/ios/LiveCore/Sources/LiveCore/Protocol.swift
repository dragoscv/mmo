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

public struct SessionState: Codable, Sendable, Equatable {
    public var preset: String
    public var chain: [InsertState]
    public var mix: MixState
    public var setlist: Setlist?
    public var position: Position?
    public var presets: [String]
    public var bpm: Float?
    public var revision: UInt64

    public init(preset: String = "", chain: [InsertState] = [], mix: MixState = MixState(), setlist: Setlist? = nil,
                position: Position? = nil, presets: [String] = [], bpm: Float? = nil, revision: UInt64 = 0) {
        self.preset = preset; self.chain = chain; self.mix = mix; self.setlist = setlist; self.position = position
        self.presets = presets; self.bpm = bpm; self.revision = revision
    }

    enum CodingKeys: String, CodingKey { case preset, chain, mix, setlist, position, presets, bpm, revision }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        preset = (try? c.decodeIfPresent(String.self, forKey: .preset)) ?? ""
        chain = (try? c.decodeIfPresent([InsertState].self, forKey: .chain)) ?? []
        mix = (try? c.decodeIfPresent(MixState.self, forKey: .mix)) ?? MixState()
        setlist = try? c.decodeIfPresent(Setlist.self, forKey: .setlist)
        position = try? c.decodeIfPresent(Position.self, forKey: .position)
        presets = (try? c.decodeIfPresent([String].self, forKey: .presets)) ?? []
        bpm = try? c.decodeIfPresent(Float.self, forKey: .bpm)
        revision = (try? c.decodeIfPresent(UInt64.self, forKey: .revision)) ?? 0
    }

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
