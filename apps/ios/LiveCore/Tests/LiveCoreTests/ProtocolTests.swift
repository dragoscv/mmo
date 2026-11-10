import Foundation
import Testing
@testable import LiveCore

/// Frames shaped exactly like `live-remote` sends them (serde forms of `SessionState`, `meters_json`, `hello`).
enum Frames {
    static let hello = #"""
    {"engine_name":"Studio PC","sample_rate":48000,"buffer_frames":128,"devices":{"host":"WASAPI","input":"Mic","output":"Out",
    "sample_rate":48000,"buffer_frames":128,"input_channels":2,"output_channels":2,"nominal_latency_ms":5.3,"notes":[]},
    "type":"hello","protocol":1,"version":"0.1.0","role":"performer","client":"iphone-abc"}
    """#

    static let state = #"""
    {"type":"state","state":{"preset":"Warm Vocal","chain":[
      {"id":1,"fx":"gate","enabled":true,"params":[["threshold_db",-50.0],["release_ms",120.0]]},
      {"id":2,"fx":"compressor","enabled":false,"params":[["ratio",3.0]]}],
     "mix":{"input_db":0.0,"main_db":-3.0,"monitor_db":-6.0,"monitor_dry":0.25,"bypass":false,"mute":false},
     "setlist":{"version":1,"name":"Friday","songs":[
       {"title":"Song A","artist":"Band","key":"A minor","bpm":120.0,"parts":[{"name":"Verse","preset":"Warm Vocal","program":null},
         {"name":"Chorus","preset":"Big Chorus"}],"lyrics":"[Verse]\nline 1\n\n[Chorus]\nla la","notes":""},
       {"title":"Song B","parts":[{"name":"Intro","preset":"Dry"}]}]},
     "position":{"song":0,"part":0},"presets":["Warm Vocal","Big Chorus","Dry"],"bpm":null,"revision":7}}
    """#

    static let meters = #"""
    {"type":"meters","in_peak":0.5,"in_rms":0.1,"out_peak":[0.25,null],"out_rms":[0.05,0.05],"gr":[0.0,-3.5],
     "dsp_load":0.12,"dsp_load_max":0.3,"xruns":0,"clipped":false,
     "tune":{"freq":440.0,"midi":69.02,"cents":2.1,"target":69,"correction_cents":-2.0},
     "latency_probe":{"done_ms":11.5},"chain_latency_samples":64}
    """#

        /// Engine 0.1.0+midi state: factory presets, the MIDI map, an armed learn target, an unknown target kind.
        static let midiState = #"""
        {"type":"state","state":{"preset":"Pop Polish","chain":[],"mix":{"input_db":0.0,"main_db":0.0,"monitor_db":0.0,
         "monitor_dry":0.0,"bypass":false,"mute":false},"setlist":null,"position":null,
         "presets":["Pop Polish","My Voice"],"factory_presets":["Pop Polish","Warm Vocal"],"bpm":null,
         "midi":{"map":{"bindings":[
             {"source":{"kind":"cc","channel":0,"number":80},"target":{"kind":"action","action":"next"}},
             {"source":{"kind":"cc","channel":null,"number":4},"target":{"kind":"param","fx":"reverb","param":"mix"}},
             {"source":{"kind":"note","channel":9,"number":36},"target":{"kind":"warp_drive","speed":9}},
             {"source":{"kind":"cc","number":7},"target":{"kind":"mix","field":"monitor_dry"}}],
             "program_change":false,"channel":2},
            "learning":{"kind":"enable","fx":"delay"},"ports":["FS-1 Pedal","BLE MIDI"],"last":"cc 1/80 = 127"},
         "revision":3}}
        """#
}

@Suite struct ProtocolDecodeTests {
    @Test func helloDecodes() throws {
        guard case .hello(let h) = ServerMessage.decode(Frames.hello) else { Issue.record("not hello"); return }
        #expect(h.protocolVersion == 1)
        #expect(h.role == .performer)
        #expect(h.engineName == "Studio PC")
        #expect(h.devices?.host == "WASAPI")
        let ms = try #require(h.bufferMs)
        #expect(abs(ms - 2.6667) < 0.001)
    }

    @Test func stateDecodesTuplesAndSetlist() {
        guard case .state(let s) = ServerMessage.decode(Frames.state) else { Issue.record("not state"); return }
        #expect(s.preset == "Warm Vocal")
        #expect(s.chain.count == 2)
        #expect(s.chain[0].value("threshold_db") == -50)
        #expect(s.chain[1].enabled == false)
        #expect(s.mix.mainDb == -3)
        #expect(s.mix.monitorDry == 0.25)
        #expect(s.setlist?.songs[1].artist == "")
        #expect(s.currentSong?.title == "Song A")
        #expect(s.currentPart?.name == "Verse")
        #expect(s.nextPart?.part.name == "Chorus")
        #expect(s.bpm == nil)
        #expect(s.revision == 7)
    }

    @Test func nextPartCrossesSongs() throws {
        guard case .state(var s) = ServerMessage.decode(Frames.state) else { Issue.record("not state"); return }
        s.position = Position(song: 0, part: 1)
        let n = try #require(s.nextPart)
        #expect(n.song.title == "Song B")
        #expect(n.part.name == "Intro")
        s.position = Position(song: 1, part: 0)
        #expect(s.nextPart == nil)
    }

    @Test func metersDecodeNullsAndExtras() throws {
        guard case .meters(let m) = ServerMessage.decode(Frames.meters) else { Issue.record("not meters"); return }
        #expect(m.inPeak == 0.5)
        #expect(m.outPeak == [0.25, 0])
        #expect(m.gr == [0, -3.5])
        #expect(m.dspPercent == 12)
        #expect(m.latencyProbe == .done(ms: 11.5))
        let t = try #require(m.tune)
        #expect(t.noteName == "A4")
    }

    @Test func probeStrings() {
        for (raw, want) in [("idle", LatencyProbe.idle), ("running", .running), ("failed", .failed)] {
            let f = #"{"type":"meters","in_peak":0,"latency_probe":"\#(raw)"}"#
            guard case .meters(let m) = ServerMessage.decode(f) else { Issue.record("not meters"); return }
            #expect(m.latencyProbe == want)
        }
    }

    @Test func ackErrorPongUnknown() {
        #expect(ServerMessage.decode(#"{"type":"ack","id":4}"#) == .ack(id: 4))
        #expect(ServerMessage.decode(#"{"type":"error","id":null,"code":"rate_limited","message":"too many messages"}"#)
                == .error(id: nil, code: "rate_limited", message: "too many messages"))
        #expect(ServerMessage.decode(#"{"type":"pong","t":1}"#) == .pong)
        #expect(ServerMessage.decode(#"{"type":"warp","x":1}"#) == .unknown("warp"))
        #expect(ServerMessage.decode("nope") == nil)
    }

    @Test func unknownRoleIsViewer() {
        guard case .hello(let h) = ServerMessage.decode(#"{"type":"hello","protocol":1,"role":"admin"}"#) else { Issue.record("no"); return }
        #expect(h.role == .viewer)
    }

    @Test func noteNames() {
        #expect(NoteName.name(midi: 60) == "C4")
        #expect(NoteName.name(midi: 61.4) == "C#4")
        #expect(NoteName.name(midi: 23.6) == "C1")
        #expect(NoteName.name(midi: 11) == "B-1")
        #expect(Tune(freq: 0, midi: 0, cents: 0, target: -1, correctionCents: 0).noteName == nil)
    }

    @Test func midiStateDecodes() throws {
        guard case .state(let s) = ServerMessage.decode(Frames.midiState) else { Issue.record("not state"); return }
        #expect(s.factoryPresets == ["Pop Polish", "Warm Vocal"])
        #expect(s.isFactory("Pop Polish"))
        #expect(!s.isFactory("My Voice"))
        let map = s.midi.map
        #expect(map.bindings.count == 4)
        #expect(map.bindings[0].source == MidiSource(kind: .cc, channel: 0, number: 80))
        #expect(map.bindings[0].target == .action(action: .next))
        #expect(map.bindings[1].source.channel == nil)
        #expect(map.bindings[1].target == .param(fx: "reverb", param: "mix"))
        #expect(map.bindings[2].source.displayChannel == 10)
        #expect(map.bindings[2].target == .unknown(kind: "warp_drive"))
        #expect(map.bindings[3].target == .mix(field: .monitorDry))
        #expect(map.programChange == false)
        #expect(map.channel == 2)
        #expect(map.settingsChannel == 3)
        #expect(s.midi.learning == .enable(fx: "delay"))
        #expect(s.midi.isLearning)
        #expect(s.midi.ports == ["FS-1 Pedal", "BLE MIDI"])
        #expect(s.midi.last == "cc 1/80 = 127")
        #expect(s.midi.source(for: .param(fx: "reverb", param: "mix"))?.number == 4)
        #expect(s.midi.source(for: .enable(fx: "gate")) == nil)
    }

    @Test func olderEngineStateDefaultsMidi() {
        guard case .state(let s) = ServerMessage.decode(Frames.state) else { Issue.record("not state"); return }
        #expect(s.factoryPresets.isEmpty)
        #expect(s.midi == MidiState())
        #expect(s.midi.map.programChange)
        #expect(s.midi.map.settingsChannel == 0)
        #expect(!s.midi.isLearning)
    }

    @Test func midiTargetRoundTrips() throws {
        let targets: [MidiTarget] = [.param(fx: "reverb", param: "mix"), .enable(fx: "delay"), .mix(field: .mainDb),
                                     .action(action: .toggleBypass)]
        for t in targets {
            let data = try JSONEncoder().encode(t)
            #expect(try JSONDecoder().decode(MidiTarget.self, from: data) == t)
        }
        let o = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(MidiTarget.mix(field: .monitorDb))) as? [String: Any])
        #expect(o["kind"] as? String == "mix")
        #expect(o["field"] as? String == "monitor_db")
    }
}

@Suite struct CommandEncodeTests {
    private func object(_ s: String) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any])
    }

    @Test func setMixSendsOnlySetFields() throws {
        let o = try object(ClientCommand.setMix(MixChange(monitorDry: 0.5, mute: true)).json(id: 9))
        #expect(o["type"] as? String == "set_mix")
        #expect(o["id"] as? Int == 9)
        #expect(o["monitor_dry"] as? Double == 0.5)
        #expect(o["mute"] as? Bool == true)
        #expect(o["input_db"] == nil)
    }

    @Test func everyTypeMatchesTheSpec() throws {
        let cases: [(ClientCommand, String)] = [
            (.subscribe(meters: true, hz: 50), "subscribe"), (.setParam(insert: 1, param: "ratio", value: 4), "set_param"),
            (.setParamNorm(insert: 1, param: "ratio", norm: 2), "set_param_norm"), (.setEnabled(insert: 1, on: false), "set_enabled"),
            (.addInsert(fx: "gate", at: 0), "add_insert"), (.removeInsert(insert: 3), "remove_insert"),
            (.moveInsert(insert: 3, to: 0), "move_insert"), (.loadPreset(name: "A"), "load_preset"), (.savePreset(name: "A"), "save_preset"),
            (.goto(song: 1, part: 2), "goto"), (.next, "next"), (.prev, "prev"), (.tapTempo, "tap_tempo"), (.panic, "panic"),
            (.latencyProbe, "latency_probe"), (.ping(t: 1), "ping"),
            (.loadSetlist(Setlist(name: "S", songs: [Song(title: "T", parts: [SongPart(name: "V", preset: "P")])])), "load_setlist"),
            (.deletePreset(name: "A"), "delete_preset"), (.midiLearn(target: nil), "midi_learn"),
            (.midiUnbind(index: 0), "midi_unbind"), (.midiSettings(programChange: true), "midi_settings"),
        ]
        for (c, t) in cases { #expect(try object(c.json())["type"] as? String == t) }
        let sub = try object(ClientCommand.subscribe(meters: true, hz: 50).json())
        #expect(sub["meters_hz"] as? Int == 30)
        let norm = try object(ClientCommand.setParamNorm(insert: 1, param: "ratio", norm: 2).json())
        #expect(norm["norm"] as? Double == 1)
        let set = try object(ClientCommand.loadSetlist(Setlist(name: "S", songs: [])).json())
        #expect((set["setlist"] as? [String: Any])?["name"] as? String == "S")
    }

    @Test func midiCommandsMatchRust() throws {
        let learn = try object(ClientCommand.midiLearn(target: .param(fx: "reverb", param: "mix")).json(id: 2))
        #expect(learn["type"] as? String == "midi_learn")
        let t = try #require(learn["target"] as? [String: Any])
        #expect(t["kind"] as? String == "param")
        #expect(t["fx"] as? String == "reverb")
        #expect(t["param"] as? String == "mix")
        let action = try object(ClientCommand.midiLearn(target: .action(action: .tapTempo)).json())
        #expect((action["target"] as? [String: Any])?["action"] as? String == "tap_tempo")

        // Cancel must be an explicit JSON null, not a missing key.
        let cancel = ClientCommand.midiLearn(target: nil).json()
        #expect(cancel == #"{"target":null,"type":"midi_learn"}"#)
        #expect(try object(cancel)["target"] is NSNull)

        #expect(ClientCommand.midiUnbind(index: 3).json() == #"{"index":3,"type":"midi_unbind"}"#)
        #expect(ClientCommand.deletePreset(name: "My Voice").json() == #"{"name":"My Voice","type":"delete_preset"}"#)

        let pc = try object(ClientCommand.midiSettings(programChange: false).json())
        #expect(pc["program_change"] as? Bool == false)
        #expect(pc["channel"] == nil)
        let ch = try object(ClientCommand.midiSettings(channel: 20).json())
        #expect(ch["channel"] as? Int == 16)
        #expect(ch["program_change"] == nil)
        #expect(try object(ClientCommand.midiSettings(channel: 0).json())["channel"] as? Int == 0)
    }

    @Test func rolesMirrorEngine() {
        #expect(ClientCommand.next.requiredRole == .performer)
        #expect(ClientCommand.panic.requiredRole == .performer)
        #expect(ClientCommand.setMix(MixChange(mute: true)).requiredRole == .performer)
        #expect(ClientCommand.setParam(insert: 1, param: "x", value: 0).requiredRole == .controller)
        #expect(ClientCommand.savePreset(name: "x").requiredRole == .controller)
        #expect(ClientCommand.deletePreset(name: "x").requiredRole == .controller)
        #expect(ClientCommand.midiLearn(target: nil).requiredRole == .controller)
        #expect(ClientCommand.midiUnbind(index: 0).requiredRole == .controller)
        #expect(ClientCommand.midiSettings(channel: 1).requiredRole == .controller)
        #expect(ClientCommand.subscribe(meters: true).requiredRole == .viewer)
        #expect(Role.viewer < .performer && .performer < .controller)
    }

    @Test func coalesceKeys() {
        #expect(ClientCommand.setMix(MixChange(inputDb: 1)).coalesceKey == "mix")
        #expect(ClientCommand.setMix(MixChange(mute: true)).coalesceKey == nil)
        #expect(ClientCommand.setParam(insert: 2, param: "ratio", value: 1).coalesceKey == "p:2:ratio")
        #expect(ClientCommand.next.coalesceKey == nil)
    }
}

@Suite struct ParamSpecTests {
    @Test func logCurveMatchesRust() {
        let p = ParamSpec(id: "freq", min: 20, max: 20000, default: 1000, unit: "hz", curve: "log")
        #expect(abs(p.value(norm: 0.5) - 632.4555) < 0.01)
        #expect(abs(p.norm(value: 632.4555) - 0.5) < 0.0001)
        #expect(p.value(norm: .nan) == 20)
        #expect(p.format(1500) == "1.50 kHz")
    }

    @Test func linearClampAndChoice() {
        let p = ParamSpec(id: "mix", min: 0, max: 100, default: 50, unit: "percent")
        #expect(p.value(norm: 1.5) == 100)
        #expect(p.norm(value: -10) == 0)
        let c = ParamSpec(id: "scale", min: 0, max: 2, default: 0, unit: "choice", choices: ["major", "minor", "chromatic"])
        #expect(c.isChoice && c.format(1) == "minor")
        #expect(ParamSpec(id: "on", min: 0, max: 1, default: 1, unit: "toggle").isToggle)
    }

    @Test func fxCatalogueDecodes() throws {
        let json = #"[{"id":"gate","params":[{"id":"threshold_db","min":-80.0,"max":0.0,"default":-50.0,"unit":"db","curve":"linear","choices":[]}]}]"#
        let fx = try JSONDecoder().decode([FxSpec].self, from: Data(json.utf8))
        #expect(fx[0].param("threshold_db")?.format(-50) == "-50.0 dB")
    }
}
