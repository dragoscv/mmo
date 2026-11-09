package ro.mixai.decks.ui.engine

import ro.mixai.decks.ui.model.CrateItem
import ro.mixai.decks.ui.model.EngineState
import ro.mixai.decks.ui.model.LoadProgress
import ro.mixai.decks.ui.model.MidiAction
import ro.mixai.decks.ui.model.PeaksData
import ro.mixai.decks.ui.model.ScanProgress
import ro.mixai.decks.ui.model.TrackMeta
import ro.mixai.decks.ui.model.TrackRow

/** Mixer EQ band. */
enum class Band { LOW, MID, HIGH }

/** Monitoring routing (FFI `Routing`): cue mix 0 = cue only … 1 = master only. */
data class Monitoring(val cueMix: Float, val headphoneLevel: Float)

/**
 * Platform-neutral port over the Rust Decks core (`decks-ffi`). The JVM/Android implementation
 * ([ro.mixai.decks.ui.engine.FfiBackend] in jvmShared) wraps `DecksEngine` + `DecksLibrary` +
 * `DecksMapping`; [DemoBackend] is a pure-Kotlin stand-in used by tests and when the native
 * library cannot be loaded. Decks are 0-based. Every call is cheap and non-blocking except
 * [snapshot] / polls (also cheap: atomics on the Rust side).
 */
interface DecksBackend : AutoCloseable {
    /** Human-readable engine description for the status bar (adapter, latency …). */
    val description: String
    val isNative: Boolean

    fun start(): String?
    fun snapshot(): EngineState

    // Load
    fun load(deck: Int, path: String): Long
    fun loadStatus(ticket: Long): LoadProgress?
    fun trackMeta(deck: Int): TrackMeta?
    fun peaks(deck: Int): PeaksData?

    // Transport
    fun play(deck: Int)
    fun pause(deck: Int)
    fun cue(deck: Int, pressed: Boolean)
    fun seek(deck: Int, sec: Double)
    fun hotCueSet(deck: Int, slot: Int)
    fun hotCueJump(deck: Int, slot: Int)
    fun hotCueDelete(deck: Int, slot: Int)

    // Loops
    fun loopAuto(deck: Int, beats: Double)
    fun loopHalve(deck: Int)
    fun loopDouble(deck: Int)
    fun loopExit(deck: Int)
    fun loopIn(deck: Int)
    fun loopOut(deck: Int)
    fun loopToggle(deck: Int)
    fun beatJump(deck: Int, beats: Double)

    // Tempo / key / sync
    fun setTempo(deck: Int, ratio: Double)
    fun setKeyLock(deck: Int, on: Boolean)
    fun setKeyShift(deck: Int, semitones: Double)
    fun keyMatch(deck: Int): Double
    fun phaseSync(deck: Int, lock: Boolean)
    fun setSyncLock(deck: Int, on: Boolean)
    fun setQuantize(deck: Int, on: Boolean)
    fun setSlip(deck: Int, on: Boolean)

    // Mixer
    fun setGain(deck: Int, db: Float)
    fun setEq(deck: Int, band: Band, db: Float)
    fun setFilter(deck: Int, value: Float)
    fun setVolume(deck: Int, value: Float)
    fun setPfl(deck: Int, on: Boolean)
    fun setCrossfader(value: Float)
    fun setMasterVolume(value: Float)
    fun setMonitoring(monitoring: Monitoring)

    // Library
    fun scanFolder(folder: String): Long
    fun scanStatus(id: Long): ScanProgress?
    fun search(query: String, limit: Int): List<TrackRow>
    fun crates(): List<CrateItem>
    fun crateTracks(crateId: Long): List<TrackRow>

    // MIDI (bytes from the platform transport → mapping engine)
    fun mappingName(): String
    fun detectMapping(portName: String, usbVendor: Int?, usbProduct: Int?)
    fun onMidi(port: String, bytes: ByteArray, timestampUs: Long): List<MidiAction>
    fun feedback(): List<ByteArray>

    /** Connected mode (WP19-21): start the LAN remote server; null when unavailable (demo engine). */
    fun startRemote(): RemotePort? = null

    /** AI Transition Designer (WP19-20); null when unavailable (demo engine). */
    fun transitions(): TransitionPort? = null

    /** Set recording + automatic tracklist (WP19-22); null when unavailable (demo engine). */
    fun setRecorder(): SetRecordPort? = null
}
