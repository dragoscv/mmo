package ro.mixai.decks.ui.engine

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import ro.mixai.decks.ffi.DecksEngine
import ro.mixai.decks.ffi.DecksEngineConfig
import ro.mixai.decks.ffi.DecksLibrary
import ro.mixai.decks.ffi.DecksMapping
import ro.mixai.decks.ffi.EngineSnapshot
import ro.mixai.decks.ffi.EqBand
import ro.mixai.decks.ffi.LibraryTrack
import ro.mixai.decks.ffi.LoadState
import ro.mixai.decks.ffi.MasterClockSource
import ro.mixai.decks.ffi.ScanState
import ro.mixai.decks.ffi.decksFfiVersion
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
 * [DecksBackend] over the UniFFI bindings of `decks-ffi` (package `ro.mixai.decks.ffi`, JNA).
 * Shared by Android (libdecks_ffi.so from jniLibs) and Desktop (decks_ffi.dll / libdecks_ffi.so,
 * path given via the `uniffi.component.decks_ffi.libraryOverride` system property).
 * Every FFI error is caught: the UI must never crash because the engine refused a command.
 */
class FfiBackend(libraryDbPath: String?) : DecksBackend {
    private val engine = DecksEngine(DecksEngineConfig(null, null, null))
    private val library: DecksLibrary =
        if (libraryDbPath == null) DecksLibrary.openInMemory() else DecksLibrary.open(libraryDbPath)
    private var mapping: DecksMapping = DecksMapping.fromBuiltin(DEFAULT_MAPPING)
    private var lastSnapshot: EngineSnapshot? = null
    private var startInfo: String = "decks-ffi ${runCatching { decksFfiVersion() }.getOrDefault("?")}"
    private val json = Json { ignoreUnknownKeys = true }

    override val description: String get() = startInfo
    override val isNative: Boolean = true

    override fun start(): String? = try {
        val info = engine.start()
        startInfo = "${info.sampleRate} Hz · ${"%.1f".format(info.latencyMs)} ms" +
            (info.deviceId?.let { " · $it" } ?: "")
        runCatching { engine.setMasterClock(MasterClockSource.Auto, null) }
        null
    } catch (t: Throwable) {
        startInfo = "engine stopped"
        System.err.println("[decks] engine start failed: $t")
        t.message ?: t.toString()
    }

    override fun snapshot(): EngineState {
        val s = try {
            engine.snapshot()
        } catch (_: Throwable) {
            return EngineState()
        }
        lastSnapshot = s
        return EngineState(
            running = s.running,
            sampleRate = s.sampleRate.toInt(),
            latencyMs = s.latencyMs,
            masterVu = s.masterVu,
            masterVolume = s.masterVolume,
            crossfader = s.crossfader,
            clock = ClockState(
                sourceDeck = s.clock.sourceDeck?.toInt(),
                bpm = s.clock.bpm,
                beat = s.clock.beat,
                beatPhase = s.clock.beatPhase,
                barPhase = s.clock.barPhase,
                beatsPerBar = s.clock.beatsPerBar.toInt(),
            ),
            decks = s.decks.take(EngineState.DECKS).map { d ->
                DeckState(
                    index = d.deck.toInt(),
                    loaded = d.loaded,
                    loading = d.loading,
                    title = d.title,
                    playheadSec = d.playheadSec,
                    durationSec = d.durationSec,
                    playing = d.playing,
                    bpm = d.bpm,
                    effectiveBpm = d.effectiveBpm,
                    tempo = d.tempo,
                    keyLock = d.keyLock,
                    keyShift = d.keyShiftSemitones,
                    key = d.keyCamelot,
                    effectiveKey = d.effectiveKeyCamelot,
                    beat = d.beat,
                    barPhase = d.barPhase,
                    loopActive = d.loopActive,
                    loopStartSec = d.loopStartSec,
                    loopEndSec = d.loopEndSec,
                    slip = d.slip,
                    quantize = d.quantize,
                    syncLock = d.syncLock,
                    pfl = d.pfl,
                    cuePointSec = d.cuePointSec,
                    hotCues = d.hotCues,
                    volume = d.volume,
                    gainDb = d.gainDb,
                    vu = d.vu,
                )
            },
        )
    }

    private inline fun cmd(block: () -> Unit) {
        try {
            block()
        } catch (_: Throwable) {
            // Rejected commands (no track, engine stopped) are visible in the next snapshot.
        }
    }

    private fun Int.u(): UByte = toUByte()

    override fun load(deck: Int, path: String): Long =
        runCatching { engine.load(deck.u(), path).toLong() }.getOrDefault(-1L)

    override fun loadStatus(ticket: Long): LoadProgress? = runCatching {
        engine.loadStatus(ticket.toULong())?.let {
            LoadProgress(
                deck = it.deck.toInt(),
                phase = when (it.state) {
                    LoadState.QUEUED -> LoadPhase.QUEUED
                    LoadState.DECODING -> LoadPhase.DECODING
                    LoadState.ANALYSING -> LoadPhase.ANALYSING
                    LoadState.READY -> LoadPhase.READY
                    LoadState.FAILED -> LoadPhase.FAILED
                    LoadState.CANCELLED -> LoadPhase.CANCELLED
                },
                error = it.error,
            )
        }
    }.getOrNull()

    override fun trackMeta(deck: Int): TrackMeta? = runCatching {
        engine.trackInfo(deck.u())?.let { TrackMeta(it.title, it.bpm, it.firstBeatSec, it.keyCamelot) }
    }.getOrNull()

    override fun peaks(deck: Int): PeaksData? = runCatching {
        engine.peaks(deck.u())?.let { PeaksData(it.pointsPerSecond.toInt(), it.lowMax, it.midMax, it.highMax) }
    }.getOrNull()

    /** Raw FFI peaks, handed to the GPU renderer as-is. */
    fun rawPeaks(deck: Int) = runCatching { engine.peaks(deck.u()) }.getOrNull()

    override fun play(deck: Int) = cmd { engine.play(deck.u()) }
    override fun pause(deck: Int) = cmd { engine.pause(deck.u()) }
    override fun cue(deck: Int, pressed: Boolean) = cmd { engine.cue(deck.u(), pressed) }
    override fun seek(deck: Int, sec: Double) = cmd { engine.seek(deck.u(), sec) }
    override fun hotCueSet(deck: Int, slot: Int) = cmd { engine.hotCueSet(deck.u(), slot.u()) }
    override fun hotCueJump(deck: Int, slot: Int) = cmd { engine.hotCueJump(deck.u(), slot.u()) }
    override fun hotCueDelete(deck: Int, slot: Int) = cmd { engine.hotCueDelete(deck.u(), slot.u()) }
    override fun loopAuto(deck: Int, beats: Double) = cmd { engine.loopAuto(deck.u(), beats) }
    override fun loopHalve(deck: Int) = cmd { engine.loopHalve(deck.u()) }
    override fun loopDouble(deck: Int) = cmd { engine.loopDouble(deck.u()) }
    override fun loopExit(deck: Int) = cmd { engine.loopExit(deck.u()) }
    override fun loopIn(deck: Int) = cmd { engine.loopIn(deck.u()) }
    override fun loopOut(deck: Int) = cmd { engine.loopOut(deck.u()) }
    override fun loopToggle(deck: Int) = cmd { engine.loopToggle(deck.u()) }
    override fun beatJump(deck: Int, beats: Double) = cmd { engine.beatJump(deck.u(), beats) }
    override fun setTempo(deck: Int, ratio: Double) = cmd { engine.setTempo(deck.u(), ratio) }
    override fun setKeyLock(deck: Int, on: Boolean) = cmd { engine.setKeyLock(deck.u(), on) }
    override fun setKeyShift(deck: Int, semitones: Double) = cmd { engine.setKeyShift(deck.u(), semitones) }
    override fun keyMatch(deck: Int): Double = runCatching { engine.keyMatch(deck.u()) }.getOrDefault(0.0)
    override fun phaseSync(deck: Int, lock: Boolean) = cmd { engine.phaseSync(deck.u(), lock) }
    override fun setSyncLock(deck: Int, on: Boolean) = cmd { engine.setSyncLock(deck.u(), on) }
    override fun setQuantize(deck: Int, on: Boolean) = cmd { engine.setQuantize(deck.u(), on) }
    override fun setSlip(deck: Int, on: Boolean) = cmd { engine.setSlip(deck.u(), on) }
    override fun setGain(deck: Int, db: Float) = cmd { engine.setGain(deck.u(), db) }
    override fun setEq(deck: Int, band: Band, db: Float) = cmd {
        engine.setEq(deck.u(), when (band) { Band.LOW -> EqBand.LOW; Band.MID -> EqBand.MID; Band.HIGH -> EqBand.HIGH }, db)
    }
    override fun setFilter(deck: Int, value: Float) = cmd { engine.setFilter(deck.u(), value) }
    override fun setVolume(deck: Int, value: Float) = cmd { engine.setVolume(deck.u(), value) }
    override fun setPfl(deck: Int, on: Boolean) = cmd { engine.setPfl(deck.u(), on) }
    override fun setCrossfader(value: Float) = cmd { engine.setCrossfader(value) }
    override fun setMasterVolume(value: Float) = cmd { engine.setMasterVolume(value) }
    override fun setMonitoring(monitoring: Monitoring) = cmd {
        val r = engine.routingGet()
        engine.routingSet(r.copy(cueMix = monitoring.cueMix, headphoneLevel = monitoring.headphoneLevel))
    }

    override fun scanFolder(folder: String): Long =
        runCatching { library.scanFolder(folder).toLong() }.getOrDefault(-1L)

    override fun scanStatus(id: Long): ScanProgress? = runCatching {
        library.scanStatus(id.toULong())?.let {
            ScanProgress(
                done = it.done.toInt(),
                total = it.total.toInt(),
                finished = it.state != ScanState.RUNNING,
                failed = it.state == ScanState.FAILED,
                added = it.added.toInt(),
                error = it.error,
            )
        }
    }.getOrNull()

    private fun LibraryTrack.row() = TrackRow(
        id = id ?: path,
        path = path,
        title = title ?: path.substringAfterLast('/').substringAfterLast('\\'),
        artist = artist,
        bpm = bpm,
        key = key,
        durationSec = durationSec,
    )

    override fun search(query: String, limit: Int): List<TrackRow> = runCatching {
        val rows = if (query.isBlank()) library.allTracks().take(limit) else library.search(query, limit.toUInt())
        rows.map { it.row() }
    }.getOrDefault(emptyList())

    override fun crates(): List<CrateItem> =
        runCatching { library.crates().map { CrateItem(it.id, it.name, it.isFolder) } }.getOrDefault(emptyList())

    override fun crateTracks(crateId: Long): List<TrackRow> =
        runCatching { library.crateTracks(crateId).map { it.row() } }.getOrDefault(emptyList())

    override fun mappingName(): String = runCatching { mapping.profile().name }.getOrDefault(DEFAULT_MAPPING)

    override fun detectMapping(portName: String, usbVendor: Int?, usbProduct: Int?) {
        runCatching {
            val m = DecksMapping.detect(portName, usbVendor?.toUShort(), usbProduct?.toUShort(), null)
            mapping.close()
            mapping = m
        }
    }

    override fun onMidi(port: String, bytes: ByteArray, timestampUs: Long): List<MidiAction> = runCatching {
        mapping.onMidi(port, bytes, timestampUs.toULong()).map { a ->
            val p = runCatching { json.parseToJsonElement(a.paramsJson) as? JsonObject }.getOrNull()
            fun num(k: String) = (p?.get(k) as? JsonPrimitive)?.doubleOrNull
            MidiAction(
                group = a.group,
                kind = a.kind,
                deck = a.deck?.toInt() ?: (p?.get("channel") as? JsonPrimitive)?.intOrNull,
                value = a.value,
                delta = a.delta,
                pressed = a.pressed ?: (p?.get("pressed") as? JsonPrimitive)?.booleanOrNull,
                slot = a.slot?.toInt(),
                beats = num("beats"),
                semitones = num("semitones"),
                band = (p?.get("band") as? JsonPrimitive)?.content,
                direction = num("direction")?.toInt()
                    ?: (p?.get("direction") as? JsonPrimitive)?.content?.let { if (it.startsWith("prev") || it == "down" || it == "backward") -1 else 1 },
            )
        }
    }.getOrDefault(emptyList())

    override fun feedback(): List<ByteArray> = runCatching {
        val s = lastSnapshot ?: return emptyList()
        mapping.feedbackFromSnapshot(s).map { it.bytes }
    }.getOrDefault(emptyList())

    override fun startRemote(): RemotePort? = FfiRemote.start(engine)

    private val transitionPort by lazy { FfiTransition(engine) }
    override fun transitions(): TransitionPort? = transitionPort

    override fun close() {
        runCatching { engine.stop() }
        runCatching { engine.close() }
        runCatching { library.close() }
        runCatching { mapping.close() }
    }

    companion object {
        const val DEFAULT_MAPPING = "generic-2-deck"
    }
}
