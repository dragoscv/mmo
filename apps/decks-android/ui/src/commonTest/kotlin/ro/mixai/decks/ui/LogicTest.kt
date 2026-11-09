package ro.mixai.decks.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import ro.mixai.decks.ui.logic.DeckMath
import ro.mixai.decks.ui.logic.Format

class FormatTest {
    @Test fun timeFormatsMinutesSecondsTenths() {
        assertEquals("0:00.0", Format.time(0.0))
        assertEquals("1:05.3", Format.time(65.37))
        assertEquals("0:00.0", Format.time(-3.0))
        assertEquals("-0:10.0", Format.remaining(50.0, 60.0))
    }

    @Test fun bpmAndTempo() {
        assertEquals("—", Format.bpm(null))
        assertEquals("124.00", Format.bpm(124.0))
        assertEquals("+2.50%", Format.tempoPercent(1.025))
        assertEquals("-8.00%", Format.tempoPercent(0.92))
        assertEquals("0.00%", Format.tempoPercent(1.0))
    }

    @Test fun semitonesAndDb() {
        assertEquals("0", Format.semitones(0.0))
        assertEquals("+2", Format.semitones(2.0))
        assertEquals("-1.5", Format.semitones(-1.5))
        assertEquals("+3.0 dB", Format.db(3f))
        assertEquals("-∞ dB", Format.db(-80f))
        assertEquals("0.0 dB", Format.db(0f))
    }
}

class DeckMathTest {
    @Test fun faderRatioRoundTrip() {
        assertEquals(1.08, DeckMath.faderToRatio(1f, 0.08), 1e-9)
        assertEquals(0.92, DeckMath.faderToRatio(-1f, 0.08), 1e-9)
        assertEquals(0.5f, DeckMath.ratioToFader(1.04, 0.08), 1e-6f)
        assertEquals(1f, DeckMath.ratioToFader(1.5, 0.08))
    }

    @Test fun phaseOffsetWraps() {
        assertEquals(0.25, DeckMath.phaseOffset(10.25, 3.0), 1e-9)
        assertEquals(-0.25, DeckMath.phaseOffset(9.75, 3.0), 1e-9)
        assertEquals(0.0, DeckMath.phaseOffset(4.0, 8.0), 1e-9)
    }

    @Test fun beatInBarHandlesNegative() {
        assertEquals(1, DeckMath.beatInBar(5.4, 4))
        assertEquals(3, DeckMath.beatInBar(-0.5, 4))
    }

    @Test fun loopLabelsAndSteps() {
        assertEquals("1/4", DeckMath.loopLabel(0.25))
        assertEquals("16", DeckMath.loopLabel(16.0))
        assertEquals(8.0, DeckMath.stepLoop(4.0, true))
        assertEquals(0.25, DeckMath.stepLoop(0.25, false))
        assertEquals(32.0, DeckMath.stepLoop(32.0, true))
    }

    @Test fun midiValueCurves() {
        assertEquals(0f, DeckMath.unitToEqDb(0.5f), 1e-6f)
        assertEquals(-26f, DeckMath.unitToEqDb(0f), 1e-6f)
        assertEquals(6f, DeckMath.unitToEqDb(1f), 1e-6f)
        assertEquals(-1f, DeckMath.unitToBipolar(0f))
        assertEquals(12f, DeckMath.unitToTrimDb(1f))
    }

    @Test fun jogAngleStaysInCircle() {
        val a = DeckMath.jogAngle(1234.5)
        assertTrue(a >= 0f && a < 360f)
        assertEquals(200f, DeckMath.jogAngle(1.0), 1e-3f) // 33⅓ rpm = 200°/s
    }
}
