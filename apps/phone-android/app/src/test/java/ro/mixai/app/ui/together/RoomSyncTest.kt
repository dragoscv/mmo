package ro.mixai.app.ui.together

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import ro.mixai.tv.data.DriftCorrector
import ro.mixai.tv.data.PlaybackAnchor

class RoomSyncTest {
    private val now = 1_000_000.0
    /** Playing anchor: position 100 s was true 10 s ago, so expected = 110 s at [now]. */
    private val playing = PlaybackAnchor(playing = true, positionSec = 100.0, atServerMs = now - 10_000)
    private val paused = PlaybackAnchor(playing = false, positionSec = 42.0, atServerMs = now - 10_000)

    @Test fun inSync_returnsNone() {
        val c = DriftCorrector()
        assertEquals(SyncCommand.None, syncDecision("playing", playing, now, 110.02, true, c))
        assertFalse(c.correcting)
    }

    @Test fun ahead300ms_slowsDown() {
        val cmd = syncDecision("playing", playing, now, 110.3, true, DriftCorrector())
        assertTrue(cmd is SyncCommand.SetRate)
        assertTrue((cmd as SyncCommand.SetRate).rate < 1f)
    }

    @Test fun behind300ms_speedsUp() {
        val cmd = syncDecision("playing", playing, now, 109.7, true, DriftCorrector())
        assertTrue((cmd as SyncCommand.SetRate).rate > 1f)
    }

    @Test fun behind2s_seeksToExpected() {
        val c = DriftCorrector()
        val cmd = syncDecision("playing", playing, now, 108.0, true, c)
        assertEquals(SyncCommand.SeekTo(110.0), cmd)
        assertFalse(c.correcting)
    }

    @Test fun roomPausedWhilePlaying_pauses() {
        assertEquals(SyncCommand.Pause, syncDecision("paused", paused, now, 42.0, true, DriftCorrector()))
        assertEquals(SyncCommand.Pause, syncDecision("waiting", paused, now, 42.0, true, DriftCorrector()))
    }

    @Test fun roomPlayingWhilePaused_plays() {
        assertEquals(SyncCommand.Play, syncDecision("playing", playing, now, 110.0, false, DriftCorrector()))
    }

    @Test fun correctionEnds_restoresRateOnce() {
        val c = DriftCorrector()
        assertTrue(syncDecision("playing", playing, now, 110.3, true, c) is SyncCommand.SetRate)
        assertTrue(c.correcting)
        assertEquals(SyncCommand.SetRate(1f), syncDecision("playing", playing, now, 110.01, true, c))
        assertEquals(SyncCommand.None, syncDecision("playing", playing, now, 110.01, true, c))
    }

    @Test fun hysteresis_keepsCorrectingBetween40And120ms() {
        val c = DriftCorrector()
        syncDecision("playing", playing, now, 110.3, true, c)
        val cmd = syncDecision("playing", playing, now, 110.08, true, c)
        assertTrue(cmd is SyncCommand.SetRate && cmd.rate < 1f)
    }

    @Test fun bothPaused_farOff_seeks_nearby_none() {
        assertEquals(SyncCommand.SeekTo(42.0), syncDecision("paused", paused, now, 50.0, false, DriftCorrector()))
        assertEquals(SyncCommand.None, syncDecision("paused", paused, now, 42.5, false, DriftCorrector()))
    }

    @Test fun idle_returnsNone() {
        assertEquals(SyncCommand.None, syncDecision("idle", paused, now, 0.0, true, DriftCorrector()))
    }
}
