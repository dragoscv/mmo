package ro.mixai.live.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
    // Shape produced by the Rust engine: serde of SessionState (params as [[id, value]] tuples).
    private val stateJson = """
        {"type":"state","state":{"preset":"Warm Vocal","chain":[
          {"id":3,"fx":"eq","enabled":true,"params":[["low_gain",-2.0],["high_freq",8000.0]]},
          {"id":4,"fx":"comp","enabled":false,"params":[]}],
         "mix":{"input_db":-3.0,"main_db":0.0,"monitor_db":-6.5,"monitor_dry":0.25,"bypass":false,"mute":true},
         "setlist":{"version":1,"name":"Gig","songs":[{"title":"Song A","artist":"","key":"A minor","bpm":96.0,
           "parts":[{"name":"Verse","preset":"Warm Vocal","program":null},{"name":"Chorus","preset":"Big"}],
           "lyrics":"la la","notes":""}]},
         "position":{"song":0,"part":1},"presets":["Warm Vocal","Big"],"bpm":null,"revision":7,"future":42}}
    """.trimIndent()

    @Test fun parsesStateFromEngine() {
        val m = ServerMsg.parse(stateJson) as ServerMsg.StateMsg
        val s = m.state
        assertEquals("Warm Vocal", s.preset)
        assertEquals(2, s.chain.size)
        assertEquals(-2.0f, s.chain[0].param("low_gain"))
        assertEquals(8000f, s.chain[0].param("high_freq"))
        assertFalse(s.chain[1].enabled)
        assertEquals(-6.5f, s.mix.monitorDb)
        assertTrue(s.mix.mute)
        assertEquals("Chorus", s.currentPart?.name)
        assertEquals("Song A", s.currentSong?.title)
        assertEquals(7L, s.revision)
        assertNull(s.bpm)
    }

    @Test fun olderEngineWithoutMidiOrFactoryPresetsStillParses() {
        val s = (ServerMsg.parse(stateJson) as ServerMsg.StateMsg).state
        assertEquals(emptyList<String>(), s.factoryPresets)
        assertEquals(MidiState(), s.midi)
        assertTrue(s.midi.map.programChange)
        assertNull(s.midi.map.channel)
        assertNull(s.midi.learning)
        assertFalse(s.isFactoryPreset("Warm Vocal"))
    }

    @Test fun parsesMidiStateAndFactoryPresets() {
        val json = """
            {"type":"state","state":{"preset":"Big","chain":[],"mix":{},"setlist":null,"position":null,
             "presets":["Warm Vocal","Big","Mine"],"factory_presets":["Warm Vocal","Big"],"bpm":120.0,
             "midi":{"map":{"bindings":[
               {"source":{"kind":"cc","channel":0,"number":80},"target":{"kind":"action","action":"next"}},
               {"source":{"kind":"cc","channel":null,"number":4},"target":{"kind":"param","fx":"reverb","param":"mix"}},
               {"source":{"kind":"note","channel":9,"number":36},"target":{"kind":"mix","field":"monitor_dry"}},
               {"source":{"kind":"cc","channel":2,"number":7},"target":{"kind":"enable","fx":"comp"}},
               {"source":{"kind":"cc","channel":2,"number":8},"target":{"kind":"something_new","x":1}}],
              "program_change":false,"channel":3},
              "learning":{"kind":"param","fx":"reverb","param":"mix"},
              "ports":["BT Pedal","USB MIDI"],"last":"cc 1/64 = 100"},
             "revision":12}}
        """.trimIndent()
        val s = (ServerMsg.parse(json) as ServerMsg.StateMsg).state
        assertEquals(listOf("Warm Vocal", "Big"), s.factoryPresets)
        assertTrue(s.isFactoryPreset("Big"))
        assertFalse(s.isFactoryPreset("Mine"))
        val map = s.midi.map
        assertEquals(5, map.bindings.size)
        assertFalse(map.programChange)
        assertEquals(3, map.channel)
        assertEquals(MidiSource("cc", 0, 80), map.bindings[0].source)
        assertEquals(MidiTarget.Action(MidiAction.NEXT), map.bindings[0].target)
        assertNull(map.bindings[1].source.channel)
        assertEquals(MidiTarget.Param("reverb", "mix"), map.bindings[1].target)
        assertTrue(map.bindings[2].source.isNote)
        assertEquals(MidiTarget.Mix(MixField.MONITOR_DRY), map.bindings[2].target)
        assertEquals(MidiTarget.Enable("comp"), map.bindings[3].target)
        assertTrue(map.bindings[4].target is MidiTarget.Unknown)
        assertEquals("something_new", map.bindings[4].target.kind)
        assertEquals(MidiTarget.Param("reverb", "mix"), s.midi.learning)
        assertEquals(listOf("BT Pedal", "USB MIDI"), s.midi.ports)
        assertEquals("cc 1/64 = 100", s.midi.last)
    }

    @Test fun midiTargetsRoundTripThroughTheRustSerdeForm() {
        val cases = listOf(
            MidiTarget.Param("reverb", "mix") to """{"kind":"param","fx":"reverb","param":"mix"}""",
            MidiTarget.Enable("comp") to """{"kind":"enable","fx":"comp"}""",
            MidiTarget.Mix(MixField.MAIN_DB) to """{"kind":"mix","field":"main_db"}""",
            MidiTarget.Action(MidiAction.TOGGLE_BYPASS) to """{"kind":"action","action":"toggle_bypass"}""",
        )
        cases.forEach { (target, wire) ->
            assertEquals(obj(wire), target.toJson())
            assertEquals(target, MidiTarget.fromJson(obj(wire)))
        }
        // Every action / mix field name the engine can send is understood.
        assertEquals(MidiAction.TAP_TEMPO, MidiAction.parse("tap_tempo"))
        assertEquals(MidiAction.TOGGLE_MUTE, MidiAction.parse("toggle_mute"))
        assertNull(MidiAction.parse("sing"))
        assertEquals(MixField.INPUT_DB, MixField.parse("input_db"))
        assertEquals(MixField.MONITOR_DB, MixField.parse("monitor_db"))
        assertNull(MixField.parse("nope"))
    }

    @Test fun encodesMidiAndPresetControlsLikeTheRustControlEnum() {
        assertEquals(
            """{"type":"midi_learn","target":{"kind":"param","fx":"reverb","param":"mix"}}""",
            ClientMsg.MidiLearn(MidiTarget.Param("reverb", "mix")).toJson(),
        )
        assertEquals("""{"type":"midi_learn","target":null}""", ClientMsg.MidiLearn(null).toJson())
        assertEquals("""{"type":"midi_learn","id":4,"target":null}""", ClientMsg.MidiLearn(null).toJson(4))
        assertEquals("""{"type":"midi_unbind","index":2}""", ClientMsg.MidiUnbind(2).toJson())
        assertEquals("""{"type":"delete_preset","name":"Mine"}""", ClientMsg.DeletePreset("Mine").toJson())

        val omni = obj(ClientMsg.MidiSettings(channel = 0).toJson())
        assertEquals(0, omni["channel"]!!.jsonPrimitive.content.toInt())
        assertFalse(omni.containsKey("program_change"))
        val pc = obj(ClientMsg.MidiSettings(programChange = true).toJson())
        assertEquals("true", pc["program_change"]!!.jsonPrimitive.content)
        assertFalse(pc.containsKey("channel"))
        assertEquals(16, obj(ClientMsg.MidiSettings(channel = 99).toJson())["channel"]!!.jsonPrimitive.content.toInt())

        listOf(
            ClientMsg.MidiLearn(null), ClientMsg.MidiUnbind(0), ClientMsg.MidiSettings(channel = 1), ClientMsg.DeletePreset("x"),
        ).forEach { assertEquals(Role.CONTROLLER, it.required) }
    }

    @Test fun parsesHelloMetersAckErrorPong() {
        val h = ServerMsg.parse(
            """{"type":"hello","protocol":1,"version":"0.1.0","role":"performer","engine_name":"Stage","sample_rate":48000,
               "buffer_frames":128,"devices":{"input":"x"},"client":"phone-1"}""",
        ) as ServerMsg.HelloMsg
        assertEquals(Role.PERFORMER, h.hello.role)
        assertEquals("Stage", h.hello.engineName)
        assertFalse(h.hello.updateRequired)

        val m = ServerMsg.parse(
            """{"type":"meters","in_peak":0.5,"in_rms":0.2,"out_peak":[0.1,0.2],"out_rms":[0.05,0.06],"gr":[0.0,3.5],
               "dsp_load":0.2,"dsp_load_max":0.4,"xruns":2,"clipped":false,
               "tune":{"freq":440.0,"midi":69.1,"cents":10.0,"target":69,"correction_cents":-10.0},
               "latency_probe":{"done_ms":7.5},"chain_latency_samples":64}""",
        ) as ServerMsg.MetersMsg
        assertEquals(0.5f, m.meters.inPeak)
        assertEquals(69, m.meters.tune?.target)
        assertEquals(7.5f, m.meters.latencyDoneMs())
        val idle = ServerMsg.parse("""{"type":"meters","latency_probe":"idle","tune":null}""") as ServerMsg.MetersMsg
        assertNull(idle.meters.tune)
        assertNull(idle.meters.latencyDoneMs())

        assertEquals(ServerMsg.Ack(5), ServerMsg.parse("""{"type":"ack","id":5}"""))
        assertEquals(ServerMsg.Ack(null), ServerMsg.parse("""{"type":"ack","id":null}"""))
        val e = ServerMsg.parse("""{"type":"error","id":2,"code":"forbidden","message":"no"}""") as ServerMsg.Error
        assertEquals("forbidden", e.code)
        assertEquals(ServerMsg.Pong(123L), ServerMsg.parse("""{"type":"pong","t":123}"""))
        assertTrue(ServerMsg.parse("""{"type":"something_new","x":1}""") is ServerMsg.Unknown)
        assertNull(ServerMsg.parse("not json"))
        assertNull(ServerMsg.parse("""{"type":"state","state":null}"""))
    }

    @Test fun updateRequiredOnNewerProtocol() {
        val h = ServerMsg.parse("""{"type":"hello","protocol":2,"role":"viewer"}""") as ServerMsg.HelloMsg
        assertTrue(h.hello.updateRequired)
    }

    private fun obj(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject

    @Test fun encodesClientMessagesLikeTheRustControlEnum() {
        val mix = obj(ClientMsg.SetMix(monitorDb = -12f, mute = false).toJson(9))
        assertEquals("set_mix", mix["type"]!!.jsonPrimitive.content)
        assertEquals(9, mix["id"]!!.jsonPrimitive.content.toInt())
        assertEquals(-12f, mix["monitor_db"]!!.jsonPrimitive.content.toFloat())
        assertEquals("false", mix["mute"]!!.jsonPrimitive.content)
        assertFalse(mix.containsKey("input_db"))

        val norm = obj(ClientMsg.SetParamNorm(3, "high_freq", 1.4f).toJson())
        assertEquals(1f, norm["norm"]!!.jsonPrimitive.content.toFloat())
        assertFalse(norm.containsKey("id"))

        assertEquals("""{"type":"next","id":1}""", ClientMsg.Next.toJson(1))
        assertEquals("""{"type":"tap_tempo"}""", ClientMsg.TapTempo.toJson())
        assertEquals("""{"type":"panic"}""", ClientMsg.Panic.toJson())
        val sub = obj(ClientMsg.Subscribe(true, 99).toJson())
        assertEquals(30, sub["meters_hz"]!!.jsonPrimitive.content.toInt())
        val g = obj(ClientMsg.Goto(1, 2).toJson())
        assertEquals(2, g["part"]!!.jsonPrimitive.content.toInt())
        val en = obj(ClientMsg.SetEnabled(4, true).toJson())
        assertEquals("true", en["on"]!!.jsonPrimitive.content)
    }

    @Test fun rolesMatchEngineRequirements() {
        assertEquals(Role.PERFORMER, ClientMsg.Panic.required)
        assertEquals(Role.PERFORMER, ClientMsg.SetMix(mute = true).required)
        assertEquals(Role.PERFORMER, ClientMsg.LoadPreset("x").required)
        assertEquals(Role.CONTROLLER, ClientMsg.SetParam(1, "a", 1f).required)
        assertEquals(Role.CONTROLLER, ClientMsg.SetEnabled(1, true).required)
        assertEquals(Role.VIEWER, ClientMsg.Subscribe(true).required)
        assertTrue(Role.CONTROLLER.atLeast(Role.PERFORMER))
        assertFalse(Role.VIEWER.atLeast(Role.PERFORMER))
    }

    @Test fun paramCurvesMatchLiveDsp() {
        val log = FxParamSpec("freq", 20f, 20000f, 1000f, "hz", "log")
        assertEquals(20f, log.fromNorm(0f), 1e-3f)
        assertEquals(20000f, log.fromNorm(1f), 1e-1f)
        assertEquals(632.456f, log.fromNorm(0.5f), 0.01f)
        assertEquals(0.5f, log.toNorm(632.456f), 1e-4f)
        val lin = FxParamSpec("gain", -12f, 12f, 0f, "db")
        assertEquals(0.5f, lin.toNorm(0f), 1e-6f)
        assertEquals(12f, lin.fromNorm(2f), 1e-6f)
        val choice = FxParamSpec("mode", 0f, 3f, 0f, "choice", choices = listOf("a", "b", "c", "d"))
        assertEquals(2f, choice.fromNorm(0.6f), 0f)
        assertEquals(0f, lin.clamp(Float.NaN), 0f)
    }

    @Test fun parsesFxCatalogue() {
        val list = LiveJson.decodeFromString(
            kotlinx.serialization.builtins.ListSerializer(FxSpec.serializer()),
            """[{"id":"eq","params":[{"id":"low_gain","min":-12.0,"max":12.0,"default":0.0,"unit":"db","curve":"linear","choices":[]},
               {"id":"high_freq","min":1000.0,"max":16000.0,"default":8000.0,"unit":"hz","curve":"log","choices":[]}]}]""",
        )
        assertEquals("eq", list[0].id)
        assertTrue(list[0].params[1].isLog)
    }

    @Test fun meterMath() {
        assertEquals(0f, linToDb(1f), 1e-6f)
        assertEquals(-6.0206f, linToDb(0.5f), 1e-3f)
        assertEquals(-60f, linToDb(0f), 0f)
        assertEquals(1f, meterFill(0f), 0f)
        assertEquals(0.5f, meterFill(-30f), 0f)
        assertEquals("A4", midiName(69.2f))
        assertEquals("C-1", midiName(0f))
    }
}
