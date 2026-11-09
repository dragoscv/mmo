package ro.mixai.decks.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.DecksBackend
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.IntentUi
import ro.mixai.decks.ui.engine.PlanUi
import ro.mixai.decks.ui.engine.SafetyUi
import ro.mixai.decks.ui.engine.SuggestionUi
import ro.mixai.decks.ui.engine.TransitionPort
import ro.mixai.decks.ui.engine.TransitionRun
import ro.mixai.decks.ui.engine.TransitionStyleUi
import ro.mixai.decks.ui.engine.TransitionTrackUi

private class FakeTransitions : TransitionPort {
    var planned: Pair<Int, Int>? = null
    var runStartBeat: Double? = null
    var ticks = 0
    var candidates = 0
    override fun rankNext(playing: TransitionTrackUi, candidates: List<TransitionTrackUi>, limit: Int): List<SuggestionUi> {
        this.candidates = candidates.size
        return candidates.filter { it.id != playing.id }.map { SuggestionUi(it.id, 0.9, listOf("key_adjacent")) }
    }
    override fun plan(from: TransitionTrackUi, to: TransitionTrackUi, fromDeck: Int, toDeck: Int, fromPosSec: Double, bars: Int?, style: TransitionStyleUi?): PlanUi {
        planned = fromDeck to toDeck
        return PlanUi(style ?: TransitionStyleUi.BASS_SWAP, bars ?: 16, 4.0, 1.5, 1.02, "{}", listOf("phrase_aligned"))
    }
    override fun safety(playing: TransitionTrackUi, positionSec: Double, tempoRatio: Double, next: TransitionTrackUi?, plannedBars: Int?) =
        if (next == null) listOf(SafetyUi("ending_without_next", 1)) else emptyList()
    override fun parseIntent(text: String): IntentUi? = when {
        text.contains("mix") -> IntentUi("mix_next", bars = 8, style = TransitionStyleUi.ECHO_OUT)
        text.contains("cancel") -> IntentUi("cancel")
        else -> null
    }
    override fun startRun(automationJson: String, startBeat: Double): TransitionRun {
        runStartBeat = startBeat
        return object : TransitionRun {
            override fun tick(masterBeat: Double): Pair<Double, Boolean> { ticks++; return (ticks / 3.0).coerceAtMost(1.0) to (ticks >= 3) }
        }
    }
}

private class TBackend(val fake: FakeTransitions, inner: DecksBackend = DemoBackend { 0.0 }) : DecksBackend by inner {
    override fun transitions(): TransitionPort = fake
}

class TransitionTest {
    private fun ready(fake: FakeTransitions): DecksController {
        val ctl = DecksController(TBackend(fake))
        ctl.startEngine()
        ctl.loadToDeck(0, DemoBackend.DEMO_TRACKS[0])
        repeat(12) { ctl.tick() }
        ctl.togglePlay(0)
        repeat(2) { ctl.tick() }
        return ctl
    }

    @Test fun demoEngineHasNoDesigner() {
        val ctl = DecksController(DemoBackend { 0.0 })
        assertFalse(ctl.command("mix next"))
        assertFalse(ctl.startMix())
    }

    @Test fun suggestionsRankTheLibraryAndLoadOnTheOtherDeck() {
        val fake = FakeTransitions()
        val ctl = ready(fake)
        ctl.suggestNext()
        assertEquals(ctl.results.size, fake.candidates)
        assertTrue(ctl.suggestions.isNotEmpty())
        ctl.loadSuggestion(ctl.suggestions.first().id)
        assertTrue(ctl.controls[1].loadPhase != null || ctl.controls[1].meta != null)
    }

    @Test fun safetyWarnsWithoutANextTrack() {
        val fake = FakeTransitions()
        val ctl = ready(fake)
        repeat(30) { ctl.tick() }
        assertEquals("ending_without_next", ctl.safety.single().code)
    }

    @Test fun voiceCommandPlansStartsAndFinishesTheMix() {
        val fake = FakeTransitions()
        val ctl = ready(fake)
        ctl.loadToDeck(1, DemoBackend.DEMO_TRACKS[1])
        repeat(12) { ctl.tick() }
        assertTrue(ctl.command("mix next in 8 bars with echo"))
        assertEquals(0 to 1, fake.planned)
        assertEquals(TransitionStyleUi.ECHO_OUT, ctl.plan?.style)
        assertEquals(1.02, ctl.backend.snapshot().decks[1].tempo, 1e-9)
        assertTrue(fake.runStartBeat != null)
        repeat(3) { ctl.tick() }
        assertNull(ctl.mixProgress, "finished")
        assertNull(ctl.plan)
        assertFalse(ctl.command("what's the weather"))
    }

    @Test fun cancelStopsTheRun() {
        val fake = FakeTransitions()
        val ctl = ready(fake)
        ctl.loadToDeck(1, DemoBackend.DEMO_TRACKS[1])
        repeat(12) { ctl.tick() }
        assertTrue(ctl.startMix())
        assertEquals(0.0, ctl.mixProgress)
        assertTrue(ctl.command("cancel"))
        assertNull(ctl.mixProgress)
        val before = fake.ticks
        repeat(3) { ctl.tick() }
        assertEquals(before, fake.ticks)
    }
}
