package ro.mixai.tv.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import ro.mixai.tv.data.generated.TrackCard

class AudioPlanTest {
    private fun t(album: String = "al_1", track: Long? = 1, disc: Long? = null, lufs: Double? = null, peak: Double? = null) =
        TrackCard(id = "tr_$track", albumId = album, track = track, disc = disc, loudnessLufs = lufs, truePeakDbfs = peak)

    @Test fun `loud master is attenuated to the target`() {
        assertEquals(-6.0, AudioPlan.gainDb(-8.0, 0.5), 1e-9)
    }

    @Test fun `quiet track is boosted but capped by its true peak`() {
        // wants +6 dB, peak -4 dBTP allows only +3 dB to stay under -1 dBTP
        assertEquals(3.0, AudioPlan.gainDb(-20.0, -4.0), 1e-9)
        assertEquals(6.0, AudioPlan.gainDb(-20.0, -10.0), 1e-9)
    }

    @Test fun `unknown peak never boosts, unanalysed track is untouched`() {
        assertEquals(0.0, AudioPlan.gainDb(-20.0, null), 1e-9)
        assertEquals(-4.0, AudioPlan.gainDb(-10.0, null), 1e-9)
        assertEquals(0.0, AudioPlan.gainDb(null, -3.0), 1e-9)
    }

    @Test fun `gain is clamped to the safety range`() {
        assertEquals(AudioPlan.MAX_BOOST_DB, AudioPlan.gainDb(-60.0, -40.0), 1e-9)
        assertEquals(AudioPlan.MAX_CUT_DB, AudioPlan.gainDb(20.0, 0.0), 1e-9)
    }

    @Test fun `gainFor is unity when normalisation is off`() {
        assertEquals(1f, AudioPlan.gainFor(t(lufs = -6.0, peak = 0.0), normalize = false))
        assertEquals(0.5f, AudioPlan.gainFor(t(lufs = -8.0, peak = 0.0), normalize = true), 0.01f)
    }

    @Test fun `album continuation stays gapless`() {
        assertTrue(AudioPlan.isAlbumContinuation(t(track = 3), t(track = 4)))
        assertTrue(AudioPlan.isAlbumContinuation(t(track = 12, disc = 1), t(track = 1, disc = 2)))
        assertFalse(AudioPlan.isAlbumContinuation(t(track = 3), t(track = 5)))
        assertFalse(AudioPlan.isAlbumContinuation(t(track = 3), t(album = "al_2", track = 4)))
        assertFalse(AudioPlan.isAlbumContinuation(t(track = null), t(track = 1)))
    }

    @Test fun `fade length respects preference, album flow and short tracks`() {
        val a = t(album = "al_1", track = 1)
        val b = t(album = "al_2", track = 7)
        assertEquals(6000L, AudioPlan.fadeMs(6000, 240_000, 200_000, a, b))
        assertEquals(0L, AudioPlan.fadeMs(0, 240_000, 200_000, a, b))
        assertEquals(0L, AudioPlan.fadeMs(6000, 240_000, 200_000, t(track = 1), t(track = 2)))
        assertEquals(4000L, AudioPlan.fadeMs(6000, 12_000, 200_000, a, b))
        assertEquals(0L, AudioPlan.fadeMs(6000, 2_000, 200_000, a, b))
    }

    @Test fun `equal power curves`() {
        assertEquals(1f, AudioPlan.fadeOut(0f), 1e-6f)
        assertEquals(0f, AudioPlan.fadeIn(0f), 1e-6f)
        val mid = AudioPlan.fadeOut(0.5f)
        assertEquals(1f, mid * mid + AudioPlan.fadeIn(0.5f) * AudioPlan.fadeIn(0.5f), 1e-5f)
    }
}
