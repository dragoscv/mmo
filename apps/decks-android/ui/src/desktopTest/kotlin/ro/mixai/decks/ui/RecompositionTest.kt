package ro.mixai.decks.ui

import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import ro.mixai.decks.ui.Scenes.nodes
import ro.mixai.decks.ui.Scenes.one
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.model.DeckState
import ro.mixai.decks.ui.screens.DeckPanel
import ro.mixai.decks.ui.screens.DeckProbe
import ro.mixai.decks.ui.screens.DeckTags
import ro.mixai.decks.ui.screens.MixerPanel
import ro.mixai.decks.ui.screens.MixerProbe
import ro.mixai.decks.ui.screens.MixerTags
import ro.mixai.decks.ui.screens.deckView
import ro.mixai.decks.ui.screens.remainingSec
import ro.mixai.decks.ui.screens.splitTime

/**
 * The engine snapshot changes 60 times a second while a deck plays (playhead, beat, level). The panels must not
 * recompose with it: a deck composes from `DeckView` (the slow part of the state) and only the leaves that show a
 * moving value follow it: the time readouts recompose when their text changes, the overview and the meters
 * redraw. This test plays a deck for two seconds of frames and counts, through `LocalRecomposeProbe`, how often
 * the panel, its transport row, PLAY and the pads were composed (at most once) and how often the leaves updated.
 */
class RecompositionTest {
    private val frameNanos = 16_666_667L

    /** Plays [frames] frames: the engine advances 1/60 s and the scene renders. Returns the probe counts of those frames. */
    private fun play(scene: ImageComposeScene, ctl: DecksController, counts: HashMap<String, Int>, clock: DoubleArray, frames: Int): Map<String, Int> {
        var t = 0L
        // Settle: first composition, then the frame that follows it.
        repeat(3) {
            scene.render(t)
            t += frameNanos
        }
        counts.clear()
        repeat(frames) {
            clock[0] += 1.0 / 60
            ctl.tick()
            // The engine state was written outside a frame: tell the snapshot system, as the app's frame loop does.
            Snapshot.sendApplyNotifications()
            scene.render(t)
            t += frameNanos
        }
        return HashMap(counts)
    }

    private fun playing(clock: DoubleArray): DecksController {
        val ctl = Scenes.controller { clock[0] }
        ctl.togglePlay(0)
        ctl.tick()
        check(ctl.deck(0)!!.playing) { "deck A plays" }
        return ctl
    }

    @Test fun aPlayingDeckRecomposesItsTimeReadoutsOnly() {
        val frames = 120
        // tier → how often the remaining-time readout may recompose in two seconds: ten times a second with tenths
        // (full deck), once a second without (compact, icon).
        val tiers = listOf(Triple(PanelTier.Full, 480 to 250, 15..30), Triple(PanelTier.Compact, 340 to 190, 1..4), Triple(PanelTier.Icon, 228 to 298, 1..4))
        for ((tier, box, readout) in tiers) {
            val clock = doubleArrayOf(0.0)
            val ctl = playing(clock)
            val counts = HashMap<String, Int>()
            val scene = Scenes.scene(640, 400, box.first, box.second, 20, 20, recomposed = { counts.merge(it, 1, Int::plus) }) { m -> DeckPanel(ctl, 0, m, tier) }
            try {
                val before = ctl.deck(0)!!.playheadSec
                val got = play(scene, ctl, counts, clock, frames)
                val moved = ctl.deck(0)!!.playheadSec - before
                assertTrue(moved > 1.9 && moved < 2.1, "$tier: the playhead moved two seconds: $moved")
                // The deck and its controls: not composed again (one composition is allowed for a state that settles late).
                for (name in listOf(DeckProbe.PANEL, DeckProbe.TRANSPORT, DeckProbe.PLAY, DeckProbe.PADS)) {
                    assertTrue((got[name] ?: 0) <= 1, "$tier: '$name' was recomposed ${got[name]} times in $frames frames of a moving playhead: $got")
                }
                // The leaves that show the moving values did follow it.
                val remain = got[DeckProbe.REMAIN] ?: 0
                assertTrue(remain in readout, "$tier: the remaining-time readout recomposed $remain times, expected $readout: $got")
                val draws = got[DeckProbe.OVERVIEW_DRAW] ?: 0
                assertTrue(draws >= frames - 10, "$tier: the overview redrew $draws times in $frames frames: $got")
                // And the readout on screen is the time of the LAST frame, not the one the deck was composed with.
                val shown = scene.nodes().one(DeckTags.REMAIN).children
                    .flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }.joinToString("") { it.text }
                val (main, tenth) = splitTime(remainingSec(ctl.deck(0)!!))
                val want = "\u2212$main" + if (tier == PanelTier.Full) ".$tenth" else ""
                assertEquals(want, shown, "$tier: the remaining-time readout shows the last frame's time")
                assertTrue(shown != "\u221206:12" && shown != "\u221206:12.0", "$tier: it moved off the start (372 s track): $shown")
            } finally {
                scene.close()
            }
        }
    }

    @Test fun aStateChangeTheDeckShowsStillRecomposesIt() {
        // The counter test passes on small numbers: prove the panel is not simply dead. Pause → PLAY recomposes.
        val clock = doubleArrayOf(0.0)
        val ctl = playing(clock)
        val counts = HashMap<String, Int>()
        val scene = Scenes.scene(640, 400, 480, 250, 20, 20, recomposed = { counts.merge(it, 1, Int::plus) }) { m -> DeckPanel(ctl, 0, m, PanelTier.Full) }
        try {
            play(scene, ctl, counts, clock, 10)
            counts.clear()
            ctl.togglePlay(0)
            ctl.tick()
            Snapshot.sendApplyNotifications()
            scene.render(100 * frameNanos)
            scene.render(101 * frameNanos)
            assertTrue((counts[DeckProbe.PLAY] ?: 0) >= 1, "PLAY recomposed when the deck paused: $counts")
            val play = scene.nodes().one(DeckTags.PLAY)
            assertEquals("off", play.config.getOrNull(SemanticsProperties.StateDescription), "PLAY reads off after the pause")
        } finally {
            scene.close()
        }
    }

    @Test fun aPlayingDeckDoesNotRecomposeTheMixer() {
        val frames = 120
        val clock = doubleArrayOf(0.0)
        val ctl = playing(clock)
        val counts = HashMap<String, Int>()
        val scene = Scenes.scene(400, 400, 240, 250, 20, 20, recomposed = { counts.merge(it, 1, Int::plus) }) { m -> MixerPanel(ctl, m, PanelTier.Full) }
        try {
            val got = play(scene, ctl, counts, clock, frames)
            assertTrue((got[MixerProbe.CHANNEL] ?: 0) <= 1, "a channel was recomposed ${got[MixerProbe.CHANNEL]} times: $got")
            assertTrue((got[MixerProbe.CUE] ?: 0) <= 1, "a CUE button was recomposed ${got[MixerProbe.CUE]} times: $got")
            // Three meters (two channels, master) redraw with the level.
            assertTrue((got["meter:draw"] ?: 0) >= frames, "the level meters redrew ${got["meter:draw"]} times in $frames frames: $got")
            // The one flag a CUE button reads from the snapshot still reaches it.
            counts.clear()
            ctl.togglePfl(1)
            ctl.tick()
            Snapshot.sendApplyNotifications()
            scene.render(500 * frameNanos)
            scene.render(501 * frameNanos)
            assertTrue((counts[MixerProbe.CUE] ?: 0) >= 1, "CUE recomposed when the headphone cue changed: $counts")
            assertEquals("on", scene.nodes().one(MixerTags.cue(1)).config.getOrNull(SemanticsProperties.StateDescription))
        } finally {
            scene.close()
        }
    }

    @Test fun theDeckViewIsEqualForSnapshotsThatDifferOnlyInTheMovingValues() {
        val a = DeckState(0, loaded = true, title = "x", playing = true, durationSec = 300.0, playheadSec = 10.0, bpm = 124.0, effectiveBpm = 124.0, beat = 20.6, vu = 0.4f)
        val moved = a.copy(playheadSec = 10.0166, beat = 20.63, barPhase = 0.6, vu = 0.7f)
        assertEquals(deckView(a, 0), deckView(moved, 0), "playhead, beat and level are not part of the view")
        // A sync lock trims the tempo by a hair every frame: the texts the deck shows do not change.
        assertEquals(deckView(a, 0), deckView(a.copy(tempo = 1.000004, effectiveBpm = 124.0005), 0))
        assertTrue(deckView(a, 0) != deckView(a.copy(playing = false), 0), "play / pause is")
        assertTrue(deckView(a, 0) != deckView(a, 1), "so is which deck drives the clock")
        assertTrue(deckView(a, 0) != deckView(a.copy(playheadSec = 290.0), 0), "and the end-of-track warning")
    }
}
