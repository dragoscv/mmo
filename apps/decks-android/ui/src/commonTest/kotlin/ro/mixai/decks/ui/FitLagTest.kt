package ro.mixai.decks.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.screens.DeckFit
import ro.mixai.decks.ui.screens.FIT_LAG_DP
import ro.mixai.decks.ui.screens.FIT_SNAP_DP
import ro.mixai.decks.ui.screens.FitLag
import ro.mixai.decks.ui.screens.LIB_ROW_TOUCH_DP
import ro.mixai.decks.ui.screens.deckFit
import ro.mixai.decks.ui.screens.laggedSide
import ro.mixai.decks.ui.screens.libRowDp
import ro.mixai.decks.ui.screens.libraryRows
import ro.mixai.decks.ui.screens.mixerFit
import ro.mixai.decks.ui.screens.tierFor

/**
 * Hysteresis of the panel arrangements (screens/PanelFit.kt `FitLag`): every arrangement has thresholds (a tier
 * minimum, "tall rows from 296 dp", "captions from 540 dp"); a window dragged across one must not flip the rows
 * at every pixel. A growing box takes the richer arrangement [FIT_LAG_DP] late, a shrinking box drops it at the
 * threshold (it has to: it no longer fits). Pure arithmetic: no Compose here.
 */
class FitLagTest {
    private val deck = PanelId.DeckA

    /** The arrangement a deck panel makes for each box of [boxes], dragged in that order (one [FitLag], like one panel). */
    private fun drag(boxes: List<Pair<Double, Double>>): List<DeckFit> {
        val lag = FitLag()
        return boxes.map { (w, h) ->
            val box = lag.settle(deck, tierFor(deck, w, h), w, h)
            deckFit(box.tier, box.w, box.h)
        }
    }

    private fun widths(from: Int, to: Int, h: Double) = (if (from <= to) (from..to) else (from downTo to)).map { it.toDouble() to h }
    private fun heights(from: Int, to: Int, w: Double) = (if (from <= to) (from..to) else (from downTo to)).map { w to it.toDouble() }

    @Test fun laggedSideFollowsAShrinkingBoxAtOnceAndTrailsAGrowingOne() {
        assertEquals(300.0, laggedSide(null, 300.0), "the first arrangement is made for the box as given")
        assertEquals(290.0, laggedSide(300.0, 290.0), "shrinking: at once")
        assertEquals(300.0, laggedSide(300.0, 303.0), "growing inside the band: stays")
        assertEquals(300.0, laggedSide(300.0, 306.0), "growing by exactly the band: stays")
        assertEquals(304.0, laggedSide(300.0, 310.0), "growing past the band: trails by the band")
        assertEquals(310.0, laggedSide(300.0, 310.0, band = 0.0), "no band: no lag")
        assertEquals(6.0, FIT_LAG_DP)
    }

    @Test fun aGrowingDeckBecomesFullLaterThanAShrinkingOneStopsBeingFull() {
        // The tier threshold: a deck is full from 480 dp wide (the solver's 0.5 dp tolerance: from 479.5).
        fun isFull(f: DeckFit) = f.twoRowHeader
        val up = drag(widths(470, 500, 260.0))
        val down = drag(widths(500, 470, 260.0))
        val firstFullUp = 470 + up.indexOfFirst(::isFull)
        val lastFullDown = 500 - down.indexOfLast(::isFull)
        assertEquals(486, firstFullUp, "growing: full only $FIT_LAG_DP dp past the 480 dp threshold")
        assertEquals(480, lastFullDown, "shrinking: full down to the threshold itself")
        assertTrue(firstFullUp > lastFullDown, "the two sweeps switch at different widths")
        // Each sweep switches exactly once.
        assertEquals(1, up.zipWithNext().count { (a, b) -> isFull(a) != isFull(b) })
        assertEquals(1, down.zipWithNext().count { (a, b) -> isFull(a) != isFull(b) })
    }

    @Test fun aThresholdInsideATierHasTheSameDeadBand() {
        // A full deck takes the tall rows (22 dp title row, the phase strip) from 296 dp high (280 of content).
        fun tall(f: DeckFit) = f.row1 == 22
        assertFalse(tall(deckFit(PanelTier.Full, 600.0, 295.0)))
        assertTrue(tall(deckFit(PanelTier.Full, 600.0, 296.0)))
        val up = drag(heights(280, 320, 600.0))
        val down = drag(heights(320, 280, 600.0))
        assertEquals(302, 280 + up.indexOfFirst(::tall), "growing: tall rows 6 dp late")
        assertEquals(296, 320 - down.indexOfLast(::tall), "shrinking: tall rows down to the threshold")
        // And a width threshold of the compact deck: the tempo stepper joins the transport row from 312 dp (300 of content).
        fun stepper(f: DeckFit) = f.stepper
        val wide = drag(widths(340, 360, 190.0))
        assertTrue(wide.all(::stepper), "a compact deck at 340 dp and up always has the stepper")
    }

    @Test fun oneDpBackAndForthAcrossAThresholdDoesNotFlipTheArrangement() {
        // Without the dead band every step of these drags flips the deck between two arrangements.
        fun flips(boxes: List<Pair<Double, Double>>): Int = drag(boxes).zipWithNext().count { (a, b) -> a != b }
        val acrossTier = List(40) { (if (it % 2 == 0) 480.0 else 479.0) to 260.0 }
        assertTrue(flips(acrossTier) <= 1, "480 ↔ 479 dp wide: ${flips(acrossTier)} flips in 40 steps")
        val acrossRows = List(40) { 600.0 to (if (it % 2 == 0) 296.0 else 295.0) }
        assertTrue(flips(acrossRows) <= 1, "296 ↔ 295 dp high: ${flips(acrossRows)} flips in 40 steps")
        // The same on the way up: grow to just past the late switch, then wobble.
        val grown = widths(470, 486, 260.0) + List(40) { (if (it % 2 == 0) 485.0 else 486.0) to 260.0 }
        assertTrue(flips(grown) <= 1, "grown to 486 then 485 ↔ 486: ${flips(grown)} flips")
        // Proof that the check can fail: the same wobble through fresh state (no memory) flips every step.
        val noMemory = acrossTier.map { (w, h) -> deckFit(tierFor(deck, w, h), w, h) }.zipWithNext().count { (a, b) -> a != b }
        assertEquals(39, noMemory, "without hysteresis the arrangement changes at every step")
    }

    @Test fun aJumpIsNotADrag() {
        // Maximise, rotate, a layout change: more than FIT_SNAP_DP in one step. No lag: the box as given.
        val lag = FitLag()
        lag.settle(deck, PanelTier.Icon, 228.0, 298.0)
        val big = lag.settle(deck, PanelTier.Full, 780.0, 349.0)
        assertEquals(Triple(PanelTier.Full, 780.0, 349.0), Triple(big.tier, big.w, big.h))
        assertEquals(48.0, FIT_SNAP_DP)
        // A step of exactly the snap distance still counts as a drag.
        val lag2 = FitLag()
        lag2.settle(deck, PanelTier.Compact, 432.0, 260.0)
        val dragged = lag2.settle(deck, PanelTier.Full, 480.0, 260.0)
        assertEquals(PanelTier.Compact, dragged.tier, "480 − 6 = 474 dp: still compact")
        assertEquals(474.0, dragged.w)
        // The same box again changes nothing (the panel may ask twice).
        val again = lag2.settle(deck, PanelTier.Full, 480.0, 260.0)
        assertEquals(dragged, again)
    }

    @Test fun theArrangedBoxNeverExceedsTheRealOneAndWhatIsArrangedAlwaysFits() {
        // A long pseudo-random drag (a fixed sequence): at every step the arrangement is for a box inside the real
        // one, at a tier no richer than the solver's, and it needs no more height than the real box has.
        val lag = FitLag()
        var seed = 12345L
        fun next(n: Int): Int {
            seed = (seed * 1103515245L + 12345L) and 0x7fffffffL
            return (seed % n).toInt()
        }
        var w = 400.0
        var h = 220.0
        var steps = 0
        var lagged = 0
        repeat(4000) {
            w = (w + next(11) - 5).coerceIn(220.0, 900.0)
            h = (h + next(11) - 5).coerceIn(110.0, 600.0)
            val solver = tierFor(deck, w, h)
            val box = lag.settle(deck, solver, w, h)
            assertTrue(box.w <= w + 1e-9 && box.h <= h + 1e-9, "arranged for ${box.w}x${box.h} in a ${w}x$h box")
            assertTrue(box.w >= w - FIT_LAG_DP - 1e-9 && box.h >= h - FIT_LAG_DP - 1e-9, "never more than the band behind")
            assertTrue(box.tier.ordinal >= solver.ordinal, "tier ${box.tier} is richer than the solver's $solver")
            val fit = deckFit(box.tier, box.w, box.h)
            assertTrue(fit.minHeight <= h + 1e-9, "${box.tier} deck arranged for ${box.w}x${box.h} needs ${fit.minHeight} dp, the box has $h")
            if (box.w < w || box.h < h) lagged++
            steps++
        }
        assertEquals(4000, steps)
        assertTrue(lagged > 500, "the drag did trail: $lagged of $steps steps")
    }

    @Test fun theMixerGetsTheSameDeadBand() {
        // A mixer channel gets its head and CUE button from 150 dp of inner height: a 158 dp box at the icon tier's
        // 4 dp padding (190 dp wide is under the compact minimum, so the solver's tier is icon at every height here).
        val lag = FitLag()
        fun strip(h: Double): Boolean {
            val box = lag.settle(PanelId.Mixer, tierFor(PanelId.Mixer, 190.0, h), 190.0, h)
            return mixerFit(box.tier, box.w, box.h).strip
        }
        val up = (150..175).map { strip(it.toDouble()) }
        val firstUp = 150 + up.indexOfFirst { it }
        val down = (175 downTo 150).map { strip(it.toDouble()) }
        val lastDown = 175 - down.indexOfLast { it }
        assertEquals(158, lastDown, "shrinking: the strip stays down to its threshold")
        assertEquals(FIT_LAG_DP.toInt(), firstUp - lastDown, "the strip appears $firstUp dp growing, stays down to $lastDown dp shrinking")
    }

    @Test fun aDeckForcedUnderTheIconMinimumKeepsTheRemainingTimeAndTheBpmWhenBothFit() {
        // No room for the readout row (content under 86 dp): the readouts move into the header line.
        val wide = deckFit(PanelTier.Icon, 220.0, 90.0)
        assertTrue(!wide.readoutRow && wide.moreInHeader && wide.headerBpm, "220 dp wide: the BPM fits beside the remaining time: $wide")
        assertTrue(wide.minHeight <= 90 && wide.tpH >= 28)
        // 202 dp of content is the smallest header that holds letter, a 40 dp title, BPM, remaining time and MORE.
        assertEquals(202, DeckFit.HEADER_BOTH_MIN_W)
        assertTrue(deckFit(PanelTier.Icon, 214.0, 90.0).headerBpm, "214 − 12 = 202 dp of content")
        assertFalse(deckFit(PanelTier.Icon, 213.0, 90.0).headerBpm, "one dp less: the remaining time wins, the BPM goes to MORE")
        assertFalse(deckFit(PanelTier.Icon, 160.0, 90.0).headerBpm)
        // With the readout row (from the icon minimum up) both are always there.
        val min = deckFit(PanelTier.Icon, 220.0, 110.0)
        assertTrue(min.readoutRow && min.headerBpm)
        // Without pads or tabs the transport row is the one that takes spare height.
        assertTrue(min.transportFlex && wide.transportFlex)
        assertFalse(deckFit(PanelTier.Icon, 228.0, 298.0).transportFlex, "the phone deck has pads: they flex")
        // The key chip is in the header of the full and the compact deck, in the MORE sheet of the icon deck.
        assertTrue(deckFit(PanelTier.Full, 480.0, 250.0).keyChip && deckFit(PanelTier.Compact, 340.0, 190.0).keyChip)
        assertFalse(min.keyChip || wide.keyChip)
    }

    @Test fun libraryRowsAre48DpOnTouchInput() {
        assertEquals(48, LIB_ROW_TOUCH_DP)
        assertEquals(listOf(22, 48), listOf(libRowDp(touch = false), libRowDp(touch = true)))
        // Whole rows that fit the contract minimums: full 520×240, compact 320×160, icon 200×96.
        assertEquals(listOf(8, 5, 3), listOf(libraryRows(PanelTier.Full, 240.0), libraryRows(PanelTier.Compact, 160.0), libraryRows(PanelTier.Icon, 96.0)))
        assertEquals(
            listOf(4, 2, 1),
            listOf(libraryRows(PanelTier.Full, 240.0, 48), libraryRows(PanelTier.Compact, 160.0, 48), libraryRows(PanelTier.Icon, 96.0, 48)),
            "touch: 48 dp rows",
        )
    }
}
