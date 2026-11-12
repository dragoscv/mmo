package ro.mixai.decks.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.DemoPacks
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.model.DeckState
import ro.mixai.decks.ui.model.PeaksData
import ro.mixai.decks.ui.screens.LIB_HEAD_DP
import ro.mixai.decks.ui.screens.LIB_ROW_DP
import ro.mixai.decks.ui.screens.Phrase
import ro.mixai.decks.ui.screens.PhraseKind
import ro.mixai.decks.ui.screens.Phrases
import ro.mixai.decks.ui.screens.PlayedLog
import ro.mixai.decks.ui.screens.RemainWarn
import ro.mixai.decks.ui.screens.deckFit
import ro.mixai.decks.ui.screens.libToolbarDp
import ro.mixai.decks.ui.screens.libraryRows
import ro.mixai.decks.ui.screens.mixerFit
import ro.mixai.decks.ui.screens.remainWarn
import ro.mixai.decks.ui.screens.remainingSec
import ro.mixai.decks.ui.screens.splitTime
import ro.mixai.decks.ui.screens.tempoText
import ro.mixai.decks.ui.screens.windowFor

/**
 * The arithmetic behind the Decks 1.5 panels (screens/PanelFit.kt): what a deck / mixer / library
 * shows inline in a box. "Fits" here is a sum of row heights; that the real panels draw those rows
 * without cutting anything is checked on rendered panels in desktopTest/ContentMinimumsTest.
 */
class PanelFitTest {
    private fun min(id: PanelId, t: PanelTier) = DemoPacks.specs.getValue(id).min(t)

    @Test fun deckArrangementNeedsNoMoreHeightThanAnyBoxFromItsTierMinimumUp() {
        var boxes = 0
        for (tier in PanelTier.entries) {
            val (mw, mh) = min(PanelId.DeckA, tier)
            var w = mw
            while (w <= 1400.0) {
                var h = mh
                while (h <= 900.0) {
                    val f = deckFit(tier, w, h)
                    assertTrue(f.minHeight <= h + 1e-9, "$tier deck in ${w}x$h needs ${f.minHeight} dp: $f")
                    boxes++
                    h += 3.5
                }
                w += 23.0
            }
        }
        assertTrue(boxes > 10_000, "the sweep ran: $boxes boxes")
    }

    @Test fun deckAtTheContractMinimums() {
        // Full 480×250: everything inline under the short two-row header; the pads get 59 dp (two rows of 27).
        val full = deckFit(PanelTier.Full, 480.0, 250.0)
        assertTrue(full.twoRowHeader && full.util && full.toggles && full.tabs && !full.more)
        assertEquals(listOf(18, 24, 40, 28, 2), listOf(full.row1, full.row2, full.waveH, full.tpH, full.padRows))
        assertFalse(full.captions || full.keysInTransport || full.phase, "a 464 dp wide, short deck has no captions, no phase strip")
        assertEquals(243, full.minHeight, "175 of fixed rows and gaps + 52 of pads + 16 of padding")
        // Compact 340×190: the tabs give way; two pad rows and the loop row stay; the rest is behind MORE.
        val compact = deckFit(PanelTier.Compact, 340.0, 190.0)
        assertTrue(!compact.twoRowHeader && !compact.tabs && !compact.util && !compact.toggles)
        assertTrue(compact.more && !compact.moreInHeader && compact.sync && compact.stepper && compact.loopRow && compact.playWord)
        assertEquals(listOf(38, 28, 2), listOf(compact.waveH, compact.tpH, compact.padRows))
        assertEquals(190, compact.minHeight, "the compact minimum is used to the last dp")
        // Icon 220×110: header, BPM + remaining, CUE + PLAY, a progress line; MORE in the header.
        val icon = deckFit(PanelTier.Icon, 220.0, 110.0)
        assertTrue(icon.readoutRow && icon.more && icon.moreInHeader && icon.playWord)
        assertTrue(!icon.sync && !icon.tabs && !icon.util && !icon.loopRow)
        assertEquals(listOf(0, 40, 0), listOf(icon.waveH, icon.tpH, icon.padRows))
        assertEquals(110, icon.minHeight)
    }

    @Test fun deckInTheBoxesTheDefaultLayoutGives() {
        // Pro on a 1366×768 window: 552×239, one step under a full deck. Compact tier, but wide: everything inline.
        val laptop = deckFit(PanelTier.Compact, 552.0, 239.0)
        assertTrue(laptop.util && laptop.toggles && laptop.tabs && !laptop.more && laptop.artist)
        assertEquals(48, laptop.waveH)
        // Pro on 1920×1080: 780×349. Tall rows, captions, the phase strip, key cells up in the transport row.
        val hd = deckFit(PanelTier.Full, 780.0, 349.0)
        assertTrue(hd.captions && hd.keysInTransport && hd.phase)
        assertEquals(listOf(22, 28, 44, 32), listOf(hd.row1, hd.row2, hd.waveH, hd.tpH))
        // Phone layout: 228×298, icon tier by width, but tall: overview, two pad rows, the loop row and SYNC.
        val phone = deckFit(PanelTier.Icon, 228.0, 298.0)
        assertTrue(phone.readoutRow && phone.sync && phone.loopRow && phone.more)
        assertEquals(listOf(48, 2), listOf(phone.waveH, phone.padRows))
        // A box the solver forced under the icon minimum keeps CUE and PLAY at 28 dp or more.
        val forced = deckFit(PanelTier.Icon, 160.0, 90.0)
        assertTrue(!forced.readoutRow && forced.tpH >= 28 && forced.minHeight <= 90, "$forced")
    }

    @Test fun mixerArrangementFitsEveryBoxFromItsTierMinimumUp() {
        var boxes = 0
        for (tier in PanelTier.entries) for (xf in listOf(false, true)) {
            val (mw, mh) = min(PanelId.Mixer, tier)
            var w = mw
            while (w <= 700.0) {
                // From the contract minimum up, also when the mixer carries the crossfader row (a layout without a crossfader area).
                var h = mh
                while (h <= 900.0) {
                    val f = mixerFit(tier, w, h, xf)
                    assertTrue(f.minHeight(xf) <= h + 1e-9, "$tier mixer in ${w}x$h (crossfader $xf) needs ${f.minHeight(xf)} dp high: $f")
                    assertTrue(f.minWidth <= w + 1e-9, "$tier mixer in ${w}x$h needs ${f.minWidth} dp wide: $f")
                    assertTrue(f.faderW >= 24, "24 dp fader target: $f")
                    boxes++
                    h += 3.5
                }
                w += 7.0
            }
        }
        assertTrue(boxes > 10_000, "the sweep ran: $boxes boxes")
    }

    @Test fun mixerAtTheContractMinimums() {
        // Full 240×250: both channels whole (five knobs beside the fader) and the whole master column: no MORE.
        val full = mixerFit(PanelTier.Full, 240.0, 250.0)
        assertTrue(full.strip && full.masterKnob && full.sends && !full.more)
        assertEquals(listOf(5, 87, 32, 8), listOf(full.knobs, full.channelW, full.faderW, full.vuW))
        // Compact 200×190: the EQ beside the fader; trim, filter and the headphone knobs behind MORE.
        val compact = mixerFit(PanelTier.Compact, 200.0, 190.0)
        assertTrue(compact.strip && compact.masterKnob && !compact.sends && compact.more)
        assertEquals(listOf(3, 67, 24, 4), listOf(compact.knobs, compact.channelW, compact.faderW, compact.vuW))
        assertEquals(200, compact.minWidth, "the compact minimum width is used to the last dp")
        // Icon 150×110: faders and meters only.
        val icon = mixerFit(PanelTier.Icon, 150.0, 110.0)
        assertTrue(!icon.strip && !icon.masterKnob && !icon.sends && icon.more)
        assertEquals(listOf(0, 32, 8), listOf(icon.knobs, icon.faderW, icon.vuW))
        // Pro on a 1366×768 window (242×203): EQ, master level and the headphone knobs inline.
        val laptop = mixerFit(PanelTier.Compact, 242.0, 203.0)
        assertTrue(laptop.sends && laptop.more)
        assertEquals(3, laptop.knobs)
    }

    @Test fun libraryShowsWholeRowsOnly() {
        assertEquals(listOf(22, 20, 28, 26), listOf(LIB_ROW_DP, LIB_HEAD_DP, libToolbarDp(PanelTier.Full), libToolbarDp(PanelTier.Icon)))
        // Contract minimums: 520×240 / 320×160 / 200×96.
        assertEquals(8, libraryRows(PanelTier.Full, 240.0))
        assertEquals(5, libraryRows(PanelTier.Compact, 160.0))
        assertEquals(3, libraryRows(PanelTier.Icon, 96.0), "the icon tier has no column header")
        assertEquals(12, libraryRows(PanelTier.Full, 322.0), "Pro on a 1366×768 window")
        assertEquals(0, libraryRows(PanelTier.Full, 30.0))
        assertEquals(0, libraryRows(PanelTier.Full, -5.0))
        // Touch rows (48 dp) in the same boxes, and an unbounded height is cut to the largest box.
        assertEquals(listOf(4, 2, 1), listOf(libraryRows(PanelTier.Full, 240.0, 48), libraryRows(PanelTier.Compact, 160.0, 48), libraryRows(PanelTier.Icon, 96.0, 48)))
        assertEquals(libraryRows(PanelTier.Full, 8192.0), libraryRows(PanelTier.Full, Double.POSITIVE_INFINITY))
        assertEquals(371, libraryRows(PanelTier.Icon, Double.POSITIVE_INFINITY))
        for (h in 240..900 step 7) {
            val rows = libraryRows(PanelTier.Full, h.toDouble())
            assertTrue(28 + 20 + rows * 22 <= h && 28 + 20 + (rows + 1) * 22 > h, "$h dp: $rows rows")
        }
    }

    @Test fun listWindowFollowsTheSelectionByTheSmallestMove() {
        assertEquals(0, windowFor(0, 5, 20, 0))
        assertEquals(0, windowFor(0, 5, 20, 4), "still visible: the window stays")
        assertEquals(1, windowFor(0, 5, 20, 5), "one past the end: one row down")
        assertEquals(2, windowFor(3, 5, 20, 2), "one before the start: the selection becomes the first row")
        assertEquals(15, windowFor(0, 5, 20, 19))
        assertEquals(15, windowFor(18, 5, 20, 19), "never past the end of the list")
        assertEquals(0, windowFor(4, 5, 3, 2), "a list shorter than the window starts at 0")
        assertEquals(0, windowFor(3, 0, 10, 5))
        assertEquals(0, windowFor(3, 5, 0, 0))
    }

    @Test fun aTrackCountsAsPlayedAfterThirtySecondsOnAir() {
        val played = ArrayList<String>()
        val log = PlayedLog { played += it }
        repeat(29) { log.sample(1.0, listOf("a", null)) }
        assertTrue(played.isEmpty(), "29 s is not enough")
        log.sample(1.0, listOf("a", "a"))
        assertEquals(listOf("a"), played, "the same track on both decks is one second, not two")
        repeat(40) { log.sample(1.0, listOf("a", "b")) }
        assertEquals(listOf("a", "b"), played, "each id once")
        log.sample(-5.0, listOf("c"))
        log.sample(0.0, listOf("c"))
        assertEquals(2, played.size)
    }

    @Test fun readoutTexts() {
        assertEquals("06:12" to "4", splitTime(372.44))
        assertEquals("00:00" to "0", splitTime(-3.0))
        assertEquals("00:00" to "0", splitTime(Double.NaN))
        assertEquals("+2.5%", tempoText(1.025))
        assertEquals("-8.0%", tempoText(0.92))
        assertEquals("0.0%", tempoText(1.0))
        val d = DeckState(0, loaded = true, playing = true, durationSec = 100.0, playheadSec = 40.0, tempo = 2.0)
        assertEquals(30.0, remainingSec(d), 1e-9, "real seconds at the current tempo")
        assertEquals(RemainWarn.Soon, remainWarn(d))
        assertEquals(RemainWarn.Now, remainWarn(d.copy(playheadSec = 70.0)))
        assertEquals(RemainWarn.None, remainWarn(d.copy(playheadSec = 10.0)))
        assertEquals(RemainWarn.None, remainWarn(d.copy(playing = false)), "only a playing deck warns")
        assertEquals(RemainWarn.None, remainWarn(d.copy(loaded = false)))
        assertEquals(0.0, remainingSec(DeckState(0)))
    }

    // ---- phrase band: the cases of apps/mixai/src/lib/phrases.test.ts ----

    private val pps = 150
    private val block = 16 // 120 BPM, 4/4: one 8-bar block = 16 s

    private fun wave(blocks: List<Triple<Int, Int, Int>>): PeaksData {
        val n = blocks.size * block * pps
        val low = ByteArray(n)
        val mid = ByteArray(n)
        val high = ByteArray(n)
        blocks.forEachIndexed { b, (lo, mi, hi) ->
            for (i in b * block * pps until (b + 1) * block * pps) {
                low[i] = lo.toByte()
                mid[i] = mi.toByte()
                high[i] = hi.toByte()
            }
        }
        return PeaksData(pps, low, mid, high)
    }

    private val quiet = Triple(10, 60, 50)
    private val rise = Triple(110, 120, 120)
    private val loud = Triple(220, 180, 160)
    private val noBass = Triple(20, 150, 140)

    @Test fun aClubTrackReadsIntroBuildMainBreakMainOutroOnBlockBoundaries() {
        val blocks = listOf(quiet, quiet, rise, loud, loud, noBass, loud, loud, quiet)
        val p = Phrases.detect(wave(blocks), 120.0, 0.0, (blocks.size * block).toDouble())
        assertEquals(
            listOf(
                Phrase(PhraseKind.Intro, 0.0, 32.0), Phrase(PhraseKind.Build, 32.0, 48.0), Phrase(PhraseKind.Main, 48.0, 80.0),
                Phrase(PhraseKind.Break, 80.0, 96.0), Phrase(PhraseKind.Main, 96.0, 128.0), Phrase(PhraseKind.Outro, 128.0, 144.0),
            ),
            p,
        )
    }

    @Test fun phraseEdgeCases() {
        // Loud from start to end: one main phrase, no invented intro.
        assertEquals(listOf(Phrase(PhraseKind.Main, 0.0, 64.0)), Phrases.detect(wave(listOf(loud, loud, loud, loud)), 120.0, 0.0, 64.0))
        // A rise that does not lead into a main block is not called a build.
        val kinds = Phrases.detect(wave(listOf(loud, loud, rise, noBass, loud, loud)), 120.0, 0.0, 96.0).map { it.kind }
        assertFalse(PhraseKind.Build in kinds, "$kinds")
        // A later first beat moves the first boundary: 4 + 16 = 20 s.
        assertEquals(20.0, Phrases.detect(wave(listOf(quiet, loud, loud, quiet)), 120.0, 4.0, 64.0).first().toSec)
        // Nothing to tell apart: no tempo, no peaks, a track shorter than two blocks.
        assertTrue(Phrases.detect(wave(listOf(quiet, loud)), null, 0.0, 32.0).isEmpty())
        assertTrue(Phrases.detect(null, 120.0, 0.0, 32.0).isEmpty())
        assertTrue(Phrases.detect(wave(listOf(loud)), 120.0, 0.0, 16.0).isEmpty())
    }
}
