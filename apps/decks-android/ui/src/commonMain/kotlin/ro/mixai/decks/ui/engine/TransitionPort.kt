package ro.mixai.decks.ui.engine

/** Track features for the Transition Designer (FFI `TransitionTrack`). */
data class TransitionTrackUi(
    val id: String,
    val title: String,
    val artist: String,
    val bpm: Double?,
    val key: String?,
    val durationSec: Double,
    val firstBeatSec: Double = 0.0,
)

enum class TransitionStyleUi { BASS_SWAP, FILTER_SWEEP, ECHO_OUT, STEM_SWAP, CUT }

data class SuggestionUi(val id: String, val score: Double, val reasons: List<String>)

data class PlanUi(
    val style: TransitionStyleUi,
    val bars: Int,
    val beatsUntilStart: Double,
    val toCueSec: Double,
    val toTempoRatio: Double,
    val automationJson: String,
    val reasons: List<String>,
)

data class SafetyUi(val code: String, val severity: Int)

/** Recognised command: action (`mix_next`, `suggest`, `cancel`, `play`, `pause`, `sync`, `loop`) + fields. */
data class IntentUi(
    val action: String,
    val bars: Int? = null,
    val style: TransitionStyleUi? = null,
    val deck: Int? = null,
    val beats: Double? = null,
)

/** A running transition (FFI `TransitionRunner` bound to the engine). */
interface TransitionRun {
    /** Returns progress 0..1; `done` when finished. */
    fun tick(masterBeat: Double): Pair<Double, Boolean>
}

/**
 * AI Transition Designer (WP19-20) over `decks-ffi`. Pure functions are cheap; the runner applies
 * automation to the engine at UI rate. Tests use a fake.
 */
interface TransitionPort {
    fun rankNext(playing: TransitionTrackUi, candidates: List<TransitionTrackUi>, limit: Int): List<SuggestionUi>
    fun plan(from: TransitionTrackUi, to: TransitionTrackUi, fromDeck: Int, toDeck: Int, fromPosSec: Double, bars: Int?, style: TransitionStyleUi?): PlanUi?
    fun safety(playing: TransitionTrackUi, positionSec: Double, tempoRatio: Double, next: TransitionTrackUi?, plannedBars: Int?): List<SafetyUi>
    fun parseIntent(text: String): IntentUi?
    fun startRun(automationJson: String, startBeat: Double): TransitionRun?
}
