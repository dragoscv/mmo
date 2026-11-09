package ro.mixai.decks.ui.engine

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import ro.mixai.decks.ffi.DecksEngine
import ro.mixai.decks.ffi.EnergyTrend
import ro.mixai.decks.ffi.NextCandidate
import ro.mixai.decks.ffi.TransitionRunner
import ro.mixai.decks.ffi.TransitionStyle
import ro.mixai.decks.ffi.TransitionTrack
import ro.mixai.decks.ffi.transitionCheckSafety
import ro.mixai.decks.ffi.transitionParseIntent
import ro.mixai.decks.ffi.transitionPlan
import ro.mixai.decks.ffi.transitionRankNext

/** [TransitionPort] over `decks-ffi`; every FFI failure becomes an empty / null result. */
class FfiTransition(private val engine: DecksEngine) : TransitionPort {
    private val json = Json { ignoreUnknownKeys = true }

    private fun TransitionTrackUi.ffi() = TransitionTrack(
        id, title, artist, bpm, key, null, durationSec, firstBeatSec, 0u, null, false,
    )

    private fun TransitionStyleUi.ffi() = when (this) {
        TransitionStyleUi.BASS_SWAP -> TransitionStyle.BASS_SWAP
        TransitionStyleUi.FILTER_SWEEP -> TransitionStyle.FILTER_SWEEP
        TransitionStyleUi.ECHO_OUT -> TransitionStyle.ECHO_OUT
        TransitionStyleUi.STEM_SWAP -> TransitionStyle.STEM_SWAP
        TransitionStyleUi.CUT -> TransitionStyle.CUT
    }

    private fun TransitionStyle.ui() = when (this) {
        TransitionStyle.BASS_SWAP -> TransitionStyleUi.BASS_SWAP
        TransitionStyle.FILTER_SWEEP -> TransitionStyleUi.FILTER_SWEEP
        TransitionStyle.ECHO_OUT -> TransitionStyleUi.ECHO_OUT
        TransitionStyle.STEM_SWAP -> TransitionStyleUi.STEM_SWAP
        TransitionStyle.CUT -> TransitionStyleUi.CUT
    }

    override fun rankNext(playing: TransitionTrackUi, candidates: List<TransitionTrackUi>, limit: Int) = runCatching {
        transitionRankNext(playing.ffi(), candidates.map { NextCandidate(it.ffi(), null) }, EnergyTrend.HOLD, limit.toUInt())
            .map { SuggestionUi(it.id, it.score, it.reasons) }
    }.getOrDefault(emptyList())

    override fun plan(
        from: TransitionTrackUi, to: TransitionTrackUi, fromDeck: Int, toDeck: Int, fromPosSec: Double,
        bars: Int?, style: TransitionStyleUi?,
    ): PlanUi? = runCatching {
        val p = transitionPlan(from.ffi(), to.ffi(), fromDeck.toUByte(), toDeck.toUByte(), fromPosSec, bars?.toUInt(), style?.ffi(), 0u)
        PlanUi(p.style.ui(), p.bars.toInt(), p.beatsUntilStart, p.toCueSec, p.toTempoRatio, p.automationJson, p.reasons)
    }.getOrNull()

    override fun safety(playing: TransitionTrackUi, positionSec: Double, tempoRatio: Double, next: TransitionTrackUi?, plannedBars: Int?) =
        runCatching {
            transitionCheckSafety(playing.ffi(), positionSec, tempoRatio, next?.ffi(), plannedBars?.toUInt())
                .map { SafetyUi(it.code, it.severity.toInt()) }
        }.getOrDefault(emptyList())

    override fun parseIntent(text: String): IntentUi? = runCatching {
        val raw = transitionParseIntent(text)?.json ?: return null
        val o = json.parseToJsonElement(raw) as JsonObject
        fun s(k: String) = (o[k] as? JsonPrimitive)?.content
        IntentUi(
            action = s("action") ?: return null,
            bars = (o["bars"] as? JsonPrimitive)?.intOrNull,
            style = s("style")?.let { st -> TransitionStyleUi.entries.firstOrNull { it.name.lowercase() == st } },
            deck = (o["deck"] as? JsonPrimitive)?.intOrNull,
            beats = (o["beats"] as? JsonPrimitive)?.doubleOrNull,
        )
    }.getOrNull()

    override fun startRun(automationJson: String, startBeat: Double): TransitionRun? = runCatching {
        val r = TransitionRunner(automationJson, startBeat)
        object : TransitionRun {
            override fun tick(masterBeat: Double): Pair<Double, Boolean> = runCatching {
                val t = r.tick(engine, masterBeat)
                t.progress to t.done
            }.getOrDefault(1.0 to true)
        }
    }.getOrNull()
}
