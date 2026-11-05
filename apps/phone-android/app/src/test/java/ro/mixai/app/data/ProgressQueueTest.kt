package ro.mixai.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import ro.mixai.tv.data.generated.ProgressInput

class ProgressQueueTest {
    private fun ep(e: Long, at: Long, pos: Double = 10.0, done: Boolean? = false, s: Long = 1) =
        ProgressInput(kind = "episode", tmdbId = 42, season = s, episode = e, positionSec = pos, durationSec = 100.0, completed = done, updatedAt = at)

    private fun movie(at: Long, pos: Double = 10.0) =
        ProgressInput(kind = "movie", tmdbId = 42, positionSec = pos, durationSec = 100.0, completed = false, updatedAt = at)

    @Test
    fun newestUpdatedAtWins() {
        val out = ProgressQueue.merge(listOf(ep(1, at = 100, pos = 10.0)), listOf(ep(1, at = 200, pos = 50.0)))
        assertEquals(1, out.size)
        assertEquals(50.0, out[0].positionSec, 0.0)
    }

    @Test
    fun newestWinsEvenWhenItIsInPending() {
        val out = ProgressQueue.merge(listOf(ep(1, at = 300, pos = 70.0)), listOf(ep(1, at = 200, pos = 50.0)))
        assertEquals(70.0, out.single().positionSec, 0.0)
    }

    @Test
    fun completedWinsOnEqualTime() {
        val out = ProgressQueue.merge(listOf(ep(1, at = 100, pos = 100.0, done = true)), listOf(ep(1, at = 100, pos = 20.0, done = false)))
        assertEquals(true, out.single().completed)
        val reversed = ProgressQueue.merge(listOf(ep(1, at = 100, pos = 20.0, done = false)), listOf(ep(1, at = 100, pos = 100.0, done = true)))
        assertEquals(true, reversed.single().completed)
    }

    @Test
    fun olderCompletedLosesToNewerPartialRewatch() {
        // KDoc: completed is kept only over an OLDER or equal-time partial; a newer partial (rewatch) wins.
        val out = ProgressQueue.merge(listOf(ep(1, at = 100, pos = 100.0, done = true)), listOf(ep(1, at = 200, pos = 5.0, done = false)))
        assertEquals(false, out.single().completed)
        assertEquals(5.0, out.single().positionSec, 0.0)
    }

    @Test
    fun differentEpisodesKeptSeparately() {
        val out = ProgressQueue.merge(listOf(ep(1, at = 100)), listOf(ep(2, at = 110), ep(1, at = 120, s = 2)))
        assertEquals(3, out.size)
    }

    @Test
    fun movieAndEpisodeKeysDistinct() {
        val m = movie(at = 1)
        val e = ep(1, at = 1)
        assertNotEquals(ProgressQueue.key(m), ProgressQueue.key(e))
        assertEquals("movie:42:0:0", ProgressQueue.key(m))
        assertEquals("episode:42:1:1", ProgressQueue.key(e))
        assertEquals(2, ProgressQueue.merge(listOf(m), listOf(e)).size)
    }

    @Test
    fun resultOrderedOldestFirst() {
        val out = ProgressQueue.merge(listOf(ep(3, at = 300), ep(1, at = 100)), listOf(ep(2, at = 200), movie(at = 50)))
        assertEquals(listOf(50L, 100L, 200L, 300L), out.map { it.updatedAt })
    }

    @Test
    fun emptyInputs() {
        assertTrue(ProgressQueue.merge(emptyList(), emptyList()).isEmpty())
        assertEquals(1, ProgressQueue.merge(listOf(ep(1, at = 1)), emptyList()).size)
        assertEquals(1, ProgressQueue.merge(emptyList(), listOf(ep(1, at = 1))).size)
    }

    @Test
    fun duplicatesWithinPendingCollapse() {
        val out = ProgressQueue.merge(listOf(ep(1, at = 100, pos = 1.0), ep(1, at = 150, pos = 2.0), ep(1, at = 120, pos = 3.0)), emptyList())
        assertEquals(2.0, out.single().positionSec, 0.0)
    }
}
