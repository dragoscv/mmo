package ro.mixai.decks.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.i18n.DesktopStrings
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.model.MidiAction

class ControllerTest {
    private var now = 0.0
    private val ctl = DecksController(DemoBackend { now }).apply { startEngine() }

    private fun tickAll(frames: Int = 6) = repeat(frames) { ctl.tick() }

    private fun loadBoth() {
        ctl.loadToDeck(0, DemoBackend.DEMO_TRACKS[0])
        ctl.loadToDeck(1, DemoBackend.DEMO_TRACKS[1])
        tickAll()
    }

    @Test fun loadFromLibraryFillsMetaAndPeaks() {
        assertEquals(4, ctl.results.size)
        loadBoth()
        val d = ctl.deck(0)!!
        assertTrue(d.loaded)
        assertEquals("Night Drive", d.title)
        assertNotNull(ctl.controls[0].peaks)
        assertEquals(1, ctl.controls[0].peaksVersion)
        assertNull(ctl.controls[0].loadPhase)
    }

    @Test fun playAdvancesAndMasterClockFollowsPlayingDeck() {
        loadBoth()
        ctl.togglePlay(0)
        now = 2.0
        ctl.tick()
        val d = ctl.deck(0)!!
        assertTrue(d.playing)
        assertEquals(2.0, d.playheadSec, 1e-6)
        assertEquals(0, ctl.engine.clock.sourceDeck)
        assertEquals(124.0, ctl.engine.clock.bpm, 1e-6)
    }

    @Test fun hotCueSetThenJumpThenDelete() {
        loadBoth()
        ctl.backend.seek(0, 10.0)
        ctl.hotCue(0, 1)
        ctl.tick()
        val set = ctl.deck(0)!!.hotCues[1]
        assertNotNull(set) // quantised to the nearest beat at 124 BPM
        ctl.backend.seek(0, 50.0)
        ctl.hotCue(0, 1)
        ctl.tick()
        assertEquals(set, ctl.deck(0)!!.playheadSec, 1e-9)
        ctl.toggleHotCueDelete(0)
        ctl.hotCue(0, 1)
        ctl.tick()
        assertNull(ctl.deck(0)!!.hotCues[1])
    }

    @Test fun loopHalveDoubleTrackSize() {
        loadBoth()
        ctl.loopAuto(0)
        ctl.tick()
        assertTrue(ctl.deck(0)!!.loopActive)
        ctl.loopHalve(0)
        assertEquals(2.0, ctl.controls[0].loopBeats)
        ctl.loopDouble(0); ctl.loopDouble(0)
        assertEquals(8.0, ctl.controls[0].loopBeats)
        ctl.loopAuto(0) // second press exits
        ctl.tick()
        assertFalse(ctl.deck(0)!!.loopActive)
    }

    @Test fun tempoFaderAndRangeCyclePreserveRatio() {
        loadBoth()
        ctl.setTempoFader(0, 0.5f) // ±8 % default → +4 %
        ctl.tick()
        assertEquals(1.04, ctl.deck(0)!!.tempo, 1e-9)
        ctl.cycleTempoRange(0) // ±16 %
        ctl.tick()
        assertEquals(1.04, ctl.deck(0)!!.tempo, 1e-9)
        assertEquals(0.25f, ctl.controls[0].tempoFader, 1e-6f)
    }

    @Test fun syncMatchesTempo() {
        loadBoth()
        ctl.syncTap(1)
        ctl.tick()
        assertEquals(124.0, ctl.deck(1)!!.effectiveBpm!!, 1e-6)
    }

    @Test fun midiDispatchDrivesSameIntents() {
        loadBoth()
        assertTrue(ctl.dispatch(MidiAction("deck", "play_pause", deck = 1, pressed = true)))
        ctl.tick()
        assertTrue(ctl.deck(1)!!.playing)
        assertTrue(ctl.dispatch(MidiAction("mixer", "crossfader", value = 1f)))
        assertEquals(1f, ctl.crossfader)
        assertTrue(ctl.dispatch(MidiAction("mixer", "volume", deck = 0, value = 0.25f)))
        assertEquals(0.25f, ctl.controls[0].volume)
        assertTrue(ctl.dispatch(MidiAction("mixer", "eq", deck = 0, value = 0f, band = "low")))
        assertEquals(-26f, ctl.controls[0].eqLow)
        assertTrue(ctl.dispatch(MidiAction("deck", "tempo", deck = 0, value = -1f)))
        assertEquals(-1f, ctl.controls[0].tempoFader)
        assertTrue(ctl.dispatch(MidiAction("library", "scroll", delta = 2f)))
        assertEquals(2, ctl.selectedRow)
        assertTrue(ctl.dispatch(MidiAction("library", "load", deck = 0, pressed = true)))
        tickAll()
        assertEquals("Low Tide", ctl.deck(0)!!.title)
        assertFalse(ctl.dispatch(MidiAction("sampler", "trigger")))
        assertEquals("sampler.trigger", ctl.lastMidi)
    }

    @Test fun manualLoopInAndOutAreControllerIntentsSharedWithMidi() {
        loadBoth()
        // The deck's IN / OUT buttons call these two.
        ctl.backend.seek(0, 10.0)
        ctl.loopIn(0)
        ctl.backend.seek(0, 14.0)
        ctl.loopOut(0)
        ctl.tick()
        val a = ctl.deck(0)!!
        assertTrue(a.loopActive, "a loop runs once the end is after the start")
        assertEquals(10.0, a.loopStartSec, 1e-9)
        assertEquals(14.0, a.loopEndSec, 1e-9)
        // A controller's LOOP IN / LOOP OUT buttons go the same way.
        ctl.backend.seek(1, 5.0)
        assertTrue(ctl.dispatch(MidiAction("deck", "loop_in", deck = 1, pressed = true)))
        ctl.backend.seek(1, 9.0)
        assertTrue(ctl.dispatch(MidiAction("deck", "loop_out", deck = 1, pressed = true)))
        ctl.tick()
        val b = ctl.deck(1)!!
        assertTrue(b.loopActive)
        assertEquals(5.0, b.loopStartSec, 1e-9)
        assertEquals(9.0, b.loopEndSec, 1e-9)
        // A button release does nothing.
        ctl.backend.seek(1, 20.0)
        ctl.dispatch(MidiAction("deck", "loop_in", deck = 1, pressed = false))
        ctl.tick()
        assertEquals(5.0, ctl.deck(1)!!.loopStartSec, 1e-9)
    }

    @Test fun searchAndCrates() {
        ctl.search("tide")
        assertEquals(listOf("Low Tide"), ctl.results.map { it.title })
        ctl.selectCrate(1)
        assertEquals(2, ctl.results.size)
        ctl.selectCrate(null)
        assertEquals(1, ctl.results.size) // query still applies
    }

    @Test fun desktopStringTablesComplete() {
        for (s in Str.entries) {
            assertTrue(DesktopStrings.en.containsKey(s.key), "en missing ${s.key}")
            assertTrue(DesktopStrings.ro.containsKey(s.key), "ro missing ${s.key}")
        }
        assertEquals(DesktopStrings.en.keys, DesktopStrings.ro.keys)
    }
}
