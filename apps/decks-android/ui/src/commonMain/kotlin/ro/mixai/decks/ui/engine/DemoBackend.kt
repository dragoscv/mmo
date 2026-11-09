package ro.mixai.decks.ui.engine

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import ro.mixai.decks.ui.model.ClockState
import ro.mixai.decks.ui.model.CrateItem
import ro.mixai.decks.ui.model.DeckState
import ro.mixai.decks.ui.model.EngineState
import ro.mixai.decks.ui.model.LoadPhase
import ro.mixai.decks.ui.model.LoadProgress
import ro.mixai.decks.ui.model.MidiAction
import ro.mixai.decks.ui.model.PeaksData
import ro.mixai.decks.ui.model.ScanProgress
import ro.mixai.decks.ui.model.TrackMeta
import ro.mixai.decks.ui.model.TrackRow

/**
 * Pure-Kotlin stand-in for the Rust engine: silent transport with a simulated clock, synthetic
 * peaks and a small demo library. Used by unit tests, screenshots and as the fallback when the
 * native library cannot be loaded (the status bar then says "demo engine").
 * Time comes from [clockSec] so tests can drive it deterministically.
 */
class DemoBackend(private val clockSec: () -> Double) : DecksBackend {
    private class Deck(val index: Int) {
        var track: TrackRow? = null
        var playing = false
        var pos = 0.0
        var lastT = 0.0
        var tempo = 1.0
        var keyLock = false
        var keyShift = 0.0
        var cue = 0.0
        val hot = MutableList<Double?>(8) { null }
        var loopActive = false
        var loopStart = 0.0
        var loopEnd = 0.0
        var slip = false
        var quantize = true
        var sync = false
        var pfl = false
        var volume = 1f
        var gain = 0f
    }

    private val decks = List(EngineState.DECKS) { Deck(it) }
    private var crossfader = 0f
    private var master = 1f
    private var started = false
    private val tracks = DEMO_TRACKS.toMutableList()
    private val loads = mutableMapOf<Long, LoadProgress>()
    private var nextTicket = 1L

    override val description: String get() = "demo engine"
    override val isNative: Boolean = false

    override fun start(): String? { started = true; return null }

    private fun advance() {
        val now = clockSec()
        for (d in decks) {
            val dt = now - d.lastT
            d.lastT = now
            val t = d.track ?: continue
            if (!d.playing || dt <= 0) continue
            d.pos += dt * d.tempo
            if (d.loopActive && d.loopEnd > d.loopStart && d.pos >= d.loopEnd) {
                d.pos = d.loopStart + (d.pos - d.loopStart) % (d.loopEnd - d.loopStart)
            }
            val dur = t.durationSec ?: 0.0
            if (d.pos >= dur) { d.pos = dur; d.playing = false }
        }
    }

    private fun beatLen(d: Deck) = d.track?.bpm?.let { 60.0 / it } ?: 0.5

    override fun snapshot(): EngineState {
        advance()
        val states = decks.map { d ->
            val t = d.track
            val bpm = t?.bpm
            DeckState(
                index = d.index,
                loaded = t != null,
                title = t?.title,
                playheadSec = d.pos,
                durationSec = t?.durationSec ?: 0.0,
                playing = d.playing,
                bpm = bpm,
                effectiveBpm = bpm?.times(d.tempo),
                tempo = d.tempo,
                keyLock = d.keyLock,
                keyShift = d.keyShift,
                key = t?.key,
                effectiveKey = t?.key,
                beat = if (bpm != null) d.pos / (60.0 / bpm) else 0.0,
                barPhase = if (bpm != null) (d.pos / (60.0 / bpm)) % 4.0 else null,
                loopActive = d.loopActive,
                loopStartSec = d.loopStart,
                loopEndSec = d.loopEnd,
                slip = d.slip,
                quantize = d.quantize,
                syncLock = d.sync,
                pfl = d.pfl,
                cuePointSec = d.cue,
                hotCues = d.hot.toList(),
                volume = d.volume,
                gainDb = d.gain,
                vu = if (d.playing) (0.55f + 0.35f * abs(sin(d.pos * 7.0)).toFloat()) * d.volume else 0f,
            )
        }
        val master = states.firstOrNull { it.playing && it.bpm != null } ?: states.firstOrNull { it.bpm != null }
        val clockBpm = master?.effectiveBpm ?: 0.0
        return EngineState(
            running = started,
            sampleRate = 48000,
            latencyMs = 10f,
            masterVu = states.maxOfOrNull { it.vu } ?: 0f,
            masterVolume = this.master,
            crossfader = crossfader,
            clock = ClockState(
                sourceDeck = master?.index,
                bpm = clockBpm,
                beat = master?.beat ?: 0.0,
                beatPhase = (master?.beat ?: 0.0) - floor(master?.beat ?: 0.0),
                barPhase = master?.barPhase,
            ),
            decks = states,
        )
    }

    override fun load(deck: Int, path: String): Long {
        val t = tracks.firstOrNull { it.path == path } ?: TrackRow(path, path, path.substringAfterLast('/'), null, 124.0, "8A", 300.0)
        decks[deck].apply {
            track = t; playing = false; pos = 0.0; cue = 0.0; loopActive = false
            hot.indices.forEach { hot[it] = null }
            lastT = clockSec()
        }
        val ticket = nextTicket++
        loads[ticket] = LoadProgress(deck, LoadPhase.READY, null)
        return ticket
    }

    override fun loadStatus(ticket: Long) = loads[ticket]
    override fun trackMeta(deck: Int) = decks[deck].track?.let { TrackMeta(it.title, it.bpm, 0.0, it.key) }

    override fun peaks(deck: Int): PeaksData? {
        val t = decks[deck].track ?: return null
        val pps = 150
        val n = ((t.durationSec ?: 0.0) * pps).toInt()
        val seed = t.id.hashCode()
        fun lane(f: Double, ph: Double) = ByteArray(n) { i ->
            val x = i.toDouble() / pps
            val beat = x * (t.bpm ?: 120.0) / 60.0
            val env = 0.35 + 0.65 * (1.0 - (beat - floor(beat))).pow(3)
            val v = env * (0.6 + 0.4 * sin(x * f + ph + seed % 7))
            (v.coerceIn(0.0, 1.0) * 255).roundToInt().toByte()
        }
        return PeaksData(pps, lane(0.7, 0.0), lane(2.3, 1.0), lane(5.1, 2.0))
    }

    private fun quantized(d: Deck, sec: Double): Double {
        if (!d.quantize) return sec
        val b = beatLen(d)
        return (sec / b).roundToInt() * b
    }

    override fun play(deck: Int) { decks[deck].apply { if (track != null) { lastT = clockSec(); playing = true } } }
    override fun pause(deck: Int) { advance(); decks[deck].playing = false }
    override fun cue(deck: Int, pressed: Boolean) {
        advance()
        val d = decks[deck]
        if (!pressed) return
        if (d.playing) { d.playing = false; d.pos = d.cue } else if (abs(d.pos - d.cue) < 1e-3) d.pos = d.cue else d.cue = quantized(d, d.pos)
    }
    override fun seek(deck: Int, sec: Double) { advance(); decks[deck].pos = sec.coerceAtLeast(0.0) }
    override fun hotCueSet(deck: Int, slot: Int) { advance(); decks[deck].apply { hot[slot] = quantized(this, pos) } }
    override fun hotCueJump(deck: Int, slot: Int) { advance(); decks[deck].apply { hot[slot]?.let { pos = it } } }
    override fun hotCueDelete(deck: Int, slot: Int) { decks[deck].hot[slot] = null }
    override fun loopAuto(deck: Int, beats: Double) {
        advance()
        decks[deck].apply { loopStart = quantized(this, pos); loopEnd = loopStart + beats * beatLen(this); loopActive = true }
    }
    override fun loopHalve(deck: Int) { decks[deck].apply { loopEnd = loopStart + (loopEnd - loopStart) / 2 } }
    override fun loopDouble(deck: Int) { decks[deck].apply { loopEnd = loopStart + (loopEnd - loopStart) * 2 } }
    override fun loopExit(deck: Int) { decks[deck].loopActive = false }
    override fun loopIn(deck: Int) { advance(); decks[deck].apply { loopStart = pos } }
    override fun loopOut(deck: Int) { advance(); decks[deck].apply { loopEnd = pos; loopActive = loopEnd > loopStart } }
    override fun loopToggle(deck: Int) { decks[deck].apply { loopActive = !loopActive && loopEnd > loopStart } }
    override fun beatJump(deck: Int, beats: Double) {
        advance(); decks[deck].apply { pos = (pos + beats * beatLen(this)).coerceAtLeast(0.0) }
    }
    override fun setTempo(deck: Int, ratio: Double) { advance(); decks[deck].tempo = ratio }
    override fun setKeyLock(deck: Int, on: Boolean) { decks[deck].keyLock = on }
    override fun setKeyShift(deck: Int, semitones: Double) { decks[deck].keyShift = semitones }
    override fun keyMatch(deck: Int): Double = 0.0
    override fun phaseSync(deck: Int, lock: Boolean) {
        val other = decks.firstOrNull { it.index != deck && it.track?.bpm != null } ?: return
        val me = decks[deck]
        val ob = other.track?.bpm ?: return
        val mb = me.track?.bpm ?: return
        me.tempo = ob * other.tempo / mb
        me.sync = lock
    }
    override fun setSyncLock(deck: Int, on: Boolean) { if (on) phaseSync(deck, true) else decks[deck].sync = false }
    override fun setQuantize(deck: Int, on: Boolean) { decks[deck].quantize = on }
    override fun setSlip(deck: Int, on: Boolean) { decks[deck].slip = on }
    override fun setGain(deck: Int, db: Float) { decks[deck].gain = db }
    override fun setEq(deck: Int, band: Band, db: Float) = Unit
    override fun setFilter(deck: Int, value: Float) = Unit
    override fun setVolume(deck: Int, value: Float) { decks[deck].volume = value }
    override fun setPfl(deck: Int, on: Boolean) { decks[deck].pfl = on }
    override fun setCrossfader(value: Float) { crossfader = value }
    override fun setMasterVolume(value: Float) { master = value }
    override fun setMonitoring(monitoring: Monitoring) = Unit

    override fun scanFolder(folder: String): Long = 1L
    override fun scanStatus(id: Long) = ScanProgress(tracks.size, tracks.size, true, false, 0, null)
    override fun search(query: String, limit: Int): List<TrackRow> =
        tracks.filter { q -> query.isBlank() || listOfNotNull(q.title, q.artist, q.key).any { it.contains(query, ignoreCase = true) } }
            .take(limit)
    override fun crates() = listOf(CrateItem(1, "Warm-up", false), CrateItem(2, "Peak time", false))
    override fun crateTracks(crateId: Long) = if (crateId == 1L) tracks.take(2) else tracks.drop(2)
    override fun mappingName() = "Generic MIDI (demo)"
    override fun detectMapping(portName: String, usbVendor: Int?, usbProduct: Int?) = Unit
    override fun onMidi(port: String, bytes: ByteArray, timestampUs: Long): List<MidiAction> = emptyList()
    override fun feedback(): List<ByteArray> = emptyList()
    override fun close() = Unit

    companion object {
        val DEMO_TRACKS = listOf(
            TrackRow("demo-1", "demo://1", "Night Drive", "MixAI", 124.0, "8A", 372.0),
            TrackRow("demo-2", "demo://2", "Copper Sky", "MixAI", 126.0, "9A", 344.0),
            TrackRow("demo-3", "demo://3", "Low Tide", "MixAI", 122.0, "3B", 401.0),
            TrackRow("demo-4", "demo://4", "Glass Hours", "MixAI", 128.0, "10A", 298.0),
        )
    }
}
