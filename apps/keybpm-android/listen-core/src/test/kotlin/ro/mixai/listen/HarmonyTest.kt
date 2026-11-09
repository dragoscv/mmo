package ro.mixai.listen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HarmonyTest {
    private val C = 0
    private val G = 7
    private val Am = 21
    private val Em = 16
    private val F = 5

    @Test fun camelotMatchesTheWheel() {
        assertEquals("8B", Harmony.camelot(C))
        assertEquals("9B", Harmony.camelot(G))
        assertEquals("8A", Harmony.camelot(Am))
        assertEquals("9A", Harmony.camelot(Em))
        assertEquals("7B", Harmony.camelot(F))
        assertEquals(24, (0 until 24).map { Harmony.camelot(it) }.toSet().size)
    }

    @Test fun wheelDistance() {
        assertEquals(0, Harmony.wheelDistance(Am, Am))
        assertEquals(1, Harmony.wheelDistance(Am, C)) // relative
        assertEquals(1, Harmony.wheelDistance(Am, Em)) // +1
        assertEquals(2, Harmony.wheelDistance(Am, Harmony.index(11, true))) // 8A -> 10A energy boost
        assertEquals(2, Harmony.wheelDistance(Am, G)) // diagonal 8A -> 9B
    }

    @Test fun tempoMatchAllowsHalfAndDoubleTime() {
        assertEquals(0.0, Harmony.tempoMatchPercent(140.0, 70.0), 1e-9)
        assertEquals(1.6129, Harmony.tempoMatchPercent(126.0, 124.0), 1e-3)
        assertEquals(-3.2258, Harmony.tempoMatchPercent(120.0, 124.0), 1e-3)
    }

    @Test fun semitonesForRate() {
        assertEquals(1.0, Harmony.semitonesForRate(5.946), 1e-3)
        assertEquals(0.0, Harmony.semitonesForRate(0.0), 1e-9)
    }

    @Test fun mixAdviceSuggestsTransposeForClashingKeys() {
        // Live 8A at 124, track D#m (2A) at 124: a tritone away; key-lock transpose picks the best neighbour.
        val a = Harmony.mixAdvice(Am, 124.0, Harmony.index(3, true), 124.0)
        assertEquals(0.0, a.ratePercent, 1e-9)
        assertNull(a.keyAtRate)
        assertEquals(true, a.distance <= 2)
        // Already compatible -> no transpose.
        val b = Harmony.mixAdvice(Am, 124.0, Em, 122.0)
        assertEquals(0, b.transpose)
        assertEquals(1, b.distance)
    }

    @Test fun bigRateChangeMovesTheKey() {
        // +6.1 % without key lock lifts the track one semitone: Am -> A#m.
        val a = Harmony.mixAdvice(Am, 132.0, Am, 124.4)
        assertEquals(Harmony.index(10, true), a.keyAtRate)
    }

    @Test fun singerTranspose() {
        // Song in E, singer centred on C (MIDI 60) -> down 4.
        assertEquals(-4, Harmony.singerTranspose(4, 60))
        assertEquals(0, Harmony.singerTranspose(0, 48))
        assertEquals(5, Harmony.singerTranspose(0, 65))
        assertEquals(-5, Harmony.singerTranspose(0, 67))
    }

    @Test fun voiceCentreIgnoresOutliers() {
        assertEquals(60, Harmony.voiceCentre(listOf(30, 59, 60, 60, 61, 60, 62, 59, 60, 90)))
        assertNull(Harmony.voiceCentre(listOf(60, 61)))
    }

    @Test fun capo() {
        assertEquals(Harmony.Capo(0, G), Harmony.capo(G))
        // Bb major -> capo 1 on A shapes.
        assertEquals(Harmony.Capo(1, 9), Harmony.capo(10))
        // F#m -> capo 2 on Em shapes.
        assertEquals(Harmony.Capo(2, Em), Harmony.capo(Harmony.index(6, true)))
    }

    @Test fun scaleAndChords() {
        assertEquals(listOf("A", "B", "C", "D", "E", "F", "G"), Harmony.scale(Am))
        assertEquals(listOf("C", "Dm", "Em", "F", "G", "Am", "Bdim"), Harmony.chords(C))
        assertEquals(listOf("Am", "Bdim", "C", "Dm", "Em", "F", "G"), Harmony.chords(Am))
    }

    @Test fun driftAlarmNeedsSustainedDrift() {
        val d = DriftMonitor(thresholdPercent = 0.5, holdMillis = 3_000)
        assertNull(d.update(120.0, 0))
        assertNull(d.update(120.4, 1_000))
        assertNull(d.update(121.2, 2_000))
        assertNull(d.update(121.2, 4_000))
        assertEquals(1.0, d.update(121.2, 5_000)!!, 1e-9)
        assertNull(d.update(120.1, 6_000))
    }
}
