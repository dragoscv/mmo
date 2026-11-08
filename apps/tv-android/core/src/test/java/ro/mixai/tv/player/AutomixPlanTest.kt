package ro.mixai.tv.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ro.mixai.tv.data.generated.TrackCard

class AutomixPlanTest {
    private fun t(bpm: Double? = null, conf: Double? = null, first: Double? = null) =
        TrackCard(id = "tr_x", albumId = "al_${bpm}", bpm = bpm, bpmConfidence = conf, firstBeatSec = first)

    private val on = AudioPrefs(crossfadeMs = 8000, automix = true)

    @Test fun `rate matches within 6 percent, folding half and double tempo`() {
        assertEquals(128f / 124f, AudioPlan.rateFor(t(128.0), t(124.0))!!, 1e-4f)
        assertEquals(1f, AudioPlan.rateFor(t(128.0), t(64.0))!!, 1e-4f)
        assertEquals(1f, AudioPlan.rateFor(t(87.0), t(174.0))!!, 1e-4f)
        assertNull(AudioPlan.rateFor(t(128.0), t(118.0)))
        assertNull(AudioPlan.rateFor(t(128.0), t(null)))
    }

    @Test fun `low-confidence or absurd tempo is ignored`() {
        assertNull(AudioPlan.rateFor(t(128.0, conf = 0.2), t(126.0)))
        assertEquals(128f / 126f, AudioPlan.rateFor(t(128.0, conf = 0.9), t(126.0))!!, 1e-4f)
        assertNull(AudioPlan.rateFor(t(500.0), t(126.0)))
    }

    @Test fun `beat-matched plan enters on the first downbeat and snaps the fade to whole bars`() {
        val p = AudioPlan.mixPlan(on, 8000, t(120.0), t(122.0, first = 0.48))
        assertTrue(p.beatMatched)
        assertEquals(480L, p.incomingStartMs)
        assertEquals(120f / 122f, p.incomingRate, 1e-4f)
        // 120 BPM → 2000 ms per bar → 8000 ms = 4 bars
        assertEquals(8000L, p.fadeMs)
        assertEquals(6000L, AudioPlan.mixPlan(on, 7900, t(120.0), t(120.0)).fadeMs)
        // shorter than a bar → the requested fade (never longer than asked)
        assertEquals(1500L, AudioPlan.mixPlan(on, 1500, t(120.0), t(120.0)).fadeMs)
    }

    @Test fun `fade starts on a downbeat of the outgoing track`() {
        // 120 BPM, first downbeat 0.5 s → downbeats at 500 + 2000k ms; plain start 200000 - 8000 = 192000 → 190500
        assertEquals(190_500L, AudioPlan.fadeStartMs(200_000, t(120.0, first = 0.5), 8000))
        assertEquals(192_000L, AudioPlan.fadeStartMs(200_000, t(120.0), 8000))
        assertEquals(192_000L, AudioPlan.fadeStartMs(200_000, t(null, first = 0.5), 8000))
    }

    @Test fun `falls back to a plain crossfade`() {
        val off = AudioPlan.mixPlan(on.copy(automix = false), 6000, t(120.0), t(121.0, first = 1.0))
        assertFalse(off.beatMatched); assertEquals(0L, off.incomingStartMs); assertEquals(1f, off.incomingRate); assertEquals(6000L, off.fadeMs)
        val noBpm = AudioPlan.mixPlan(on, 6000, t(120.0), t(null, first = 1.0))
        assertFalse(noBpm.beatMatched); assertEquals(6000L, noBpm.fadeMs)
        assertEquals(0L, AudioPlan.mixPlan(on, 0, t(120.0), t(120.0)).fadeMs)
        // a lead-in longer than 8 s is not skipped
        assertEquals(0L, AudioPlan.mixPlan(on, 6000, t(120.0), t(120.0, first = 12.0)).incomingStartMs)
    }

    @Test fun `rate glides back to native speed`() {
        assertEquals(0.98f, AudioPlan.glideRate(0.98f, 0, 4000), 1e-6f)
        assertEquals(0.99f, AudioPlan.glideRate(0.98f, 2000, 4000), 1e-6f)
        assertEquals(1f, AudioPlan.glideRate(0.98f, 5000, 4000), 1e-6f)
    }
}
