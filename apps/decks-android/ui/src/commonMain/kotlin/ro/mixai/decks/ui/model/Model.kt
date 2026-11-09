package ro.mixai.decks.ui.model

/** One deck as seen by the UI (mirror of the FFI `DeckSnapshot`, platform independent). */
data class DeckState(
    val index: Int,
    val loaded: Boolean = false,
    val loading: Boolean = false,
    val title: String? = null,
    val playheadSec: Double = 0.0,
    val durationSec: Double = 0.0,
    val playing: Boolean = false,
    val bpm: Double? = null,
    val effectiveBpm: Double? = null,
    val tempo: Double = 1.0,
    val keyLock: Boolean = false,
    val keyShift: Double = 0.0,
    val key: String? = null,
    val effectiveKey: String? = null,
    val beat: Double = 0.0,
    val barPhase: Double? = null,
    val loopActive: Boolean = false,
    val loopStartSec: Double = 0.0,
    val loopEndSec: Double = 0.0,
    val slip: Boolean = false,
    val quantize: Boolean = true,
    val syncLock: Boolean = false,
    val pfl: Boolean = false,
    val cuePointSec: Double = 0.0,
    val hotCues: List<Double?> = List(8) { null },
    val volume: Float = 1f,
    val gainDb: Float = 0f,
    val vu: Float = 0f,
)

/** Master clock (FFI `ClockSnapshot`). `sourceDeck == null` = internal clock. */
data class ClockState(
    val sourceDeck: Int? = null,
    val bpm: Double = 0.0,
    val beat: Double = 0.0,
    val beatPhase: Double = 0.0,
    val barPhase: Double? = null,
    val beatsPerBar: Int = 4,
)

data class EngineState(
    val running: Boolean = false,
    val sampleRate: Int = 0,
    val latencyMs: Float = 0f,
    val masterVu: Float = 0f,
    val masterVolume: Float = 1f,
    val crossfader: Float = 0f,
    val clock: ClockState = ClockState(),
    val decks: List<DeckState> = List(DECKS) { DeckState(it) },
) {
    companion object {
        /** MVP shows two decks (the engine has four). */
        const val DECKS = 2
    }
}

/** Track metadata needed by the waveform grid (FFI `TrackInfo`). */
data class TrackMeta(
    val title: String,
    val bpm: Double?,
    val firstBeatSec: Double?,
    val key: String?,
)

enum class LoadPhase { QUEUED, DECODING, ANALYSING, READY, FAILED, CANCELLED }

data class LoadProgress(val deck: Int, val phase: LoadPhase, val error: String?)

data class TrackRow(
    val id: String,
    val path: String,
    val title: String,
    val artist: String?,
    val bpm: Double?,
    val key: String?,
    val durationSec: Double?,
)

data class CrateItem(val id: Long, val name: String, val isFolder: Boolean)

data class ScanProgress(
    val done: Int,
    val total: Int,
    val finished: Boolean,
    val failed: Boolean,
    val added: Int,
    val error: String?,
)

/** Waveform peaks (9 lanes in the FFI; the Compose fallback only needs the max lanes). */
class PeaksData(
    val pointsPerSecond: Int,
    val low: ByteArray,
    val mid: ByteArray,
    val high: ByteArray,
) {
    val size: Int get() = minOf(low.size, mid.size, high.size)
}

/**
 * A controller event already decoded by the mapping engine (FFI `MappedAction`, flattened further:
 * the interesting `params_json` fields are lifted into typed fields).
 */
data class MidiAction(
    val group: String,
    val kind: String,
    val deck: Int? = null,
    val value: Float? = null,
    val delta: Float? = null,
    val pressed: Boolean? = null,
    val slot: Int? = null,
    val beats: Double? = null,
    val semitones: Double? = null,
    val band: String? = null,
    val direction: Int? = null,
)

/** Everything the waveform renderer needs for one frame. */
data class WaveFrame(
    val decks: List<WaveDeck>,
    val zoomSeconds: Float,
    val reducedMotion: Boolean,
)

data class WaveDeck(
    val index: Int,
    val loaded: Boolean,
    val playheadSec: Double,
    val durationSec: Double,
    val bpm: Double?,
    val firstBeatSec: Double?,
    val cuePointSec: Double,
    val hotCues: List<Double?>,
    val loopActive: Boolean,
    val loopStartSec: Double,
    val loopEndSec: Double,
    /** Bumped when a new track's peaks are available. */
    val peaksVersion: Int,
)
