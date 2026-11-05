package ro.mixai.app.downloads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SmartDownloadsTest {
    private fun ep(show: Long, s: Long, e: Long, done: Boolean = false, fileId: String = "f-$show-$s-$e") =
        EpisodeCandidate(tmdbId = show, season = s, episode = e, fileId = fileId, completed = done)

    private fun meta(fileId: String, smart: Boolean = true, watchedAt: Long? = null) =
        DownloadMeta(fileId = fileId, title = fileId, kind = "episode", smart = smart, watchedAt = watchedAt)

    private val hour = 60 * 60 * 1000L
    private val now = 1_000_000_000_000L

    @Test
    fun selectsOnlyFollowedShows() {
        val cands = listOf(ep(1, 1, 1), ep(2, 1, 1), ep(3, 1, 1))
        val out = SmartDownloads.select(cands, setOf(1L, 3L), 5)
        assertEquals(setOf(1L, 3L), out.map { it.tmdbId }.toSet())
    }

    @Test
    fun startsAfterLastCompletedEvenWithGaps() {
        val cands = listOf(ep(1, 1, 1, done = true), ep(1, 1, 2), ep(1, 1, 3, done = true), ep(1, 1, 4), ep(1, 1, 5), ep(1, 1, 6))
        val out = SmartDownloads.select(cands, setOf(1L), 2)
        assertEquals(listOf(4L, 5L), out.map { it.episode })
    }

    @Test
    fun ordersAcrossSeasonsRegardlessOfInputOrder() {
        val cands = listOf(ep(1, 2, 1), ep(1, 1, 10), ep(1, 1, 9, done = true), ep(1, 2, 2))
        val out = SmartDownloads.select(cands, setOf(1L), 3)
        assertEquals(listOf(1L to 10L, 2L to 1L, 2L to 2L), out.map { it.season to it.episode })
    }

    @Test
    fun takesAtMostNPerShow() {
        val cands = (1L..10L).map { ep(1, 1, it) } + (1L..10L).map { ep(2, 1, it) }
        val out = SmartDownloads.select(cands, setOf(1L, 2L), 3)
        assertEquals(3, out.count { it.tmdbId == 1L })
        assertEquals(3, out.count { it.tmdbId == 2L })
    }

    @Test
    fun skipsBlankFileId() {
        val cands = listOf(ep(1, 1, 1, fileId = ""), ep(1, 1, 2, fileId = "   "), ep(1, 1, 3))
        val out = SmartDownloads.select(cands, setOf(1L), 3)
        assertEquals(listOf(3L), out.map { it.episode })
    }

    @Test
    fun zeroOrNegativeNIsEmpty() {
        val cands = listOf(ep(1, 1, 1), ep(1, 1, 2))
        assertTrue(SmartDownloads.select(cands, setOf(1L), 0).isEmpty())
        assertTrue(SmartDownloads.select(cands, setOf(1L), -1).isEmpty())
    }

    @Test
    fun duplicateSeasonEpisodeCountedOnce() {
        val cands = listOf(ep(1, 1, 1, fileId = "a"), ep(1, 1, 1, fileId = "b"), ep(1, 1, 2), ep(1, 1, 3))
        val out = SmartDownloads.select(cands, setOf(1L), 2)
        assertEquals(listOf(1L, 2L), out.map { it.episode })
    }

    @Test
    fun allCompletedSelectsNothing() {
        val cands = listOf(ep(1, 1, 1, done = true), ep(1, 1, 2, done = true))
        assertTrue(SmartDownloads.select(cands, setOf(1L), 3).isEmpty())
    }

    @Test
    fun graceIs24Hours() {
        assertEquals(24 * hour, SmartDownloads.WATCHED_GRACE_MS)
    }

    @Test
    fun toDeleteRemovesSmartWatchedAtLeast24hAgo() {
        val old = meta("old", watchedAt = now - 24 * hour)
        val out = SmartDownloads.toDelete(listOf(old), selectedFileIds = emptySet(), completedFileIds = setOf("old"), now = now)
        assertEquals(listOf(old), out)
    }

    @Test
    fun toDeleteKeepsSmartWatched23hAgo() {
        val recent = meta("recent", watchedAt = now - 23 * hour)
        val out = SmartDownloads.toDelete(listOf(recent), selectedFileIds = emptySet(), completedFileIds = setOf("recent"), now = now)
        assertTrue(out.isEmpty())
    }

    @Test
    fun toDeleteKeepsCompletedWithoutWatchedAtClock() {
        val noClock = meta("nc", watchedAt = null)
        val out = SmartDownloads.toDelete(listOf(noClock), emptySet(), setOf("nc"), now)
        assertTrue(out.isEmpty())
    }

    @Test
    fun toDeleteRemovesNoLongerSelectedAndNotCompleted() {
        val gone = meta("gone")
        val kept = meta("kept")
        val out = SmartDownloads.toDelete(listOf(gone, kept), selectedFileIds = setOf("kept"), completedFileIds = emptySet(), now = now)
        assertEquals(listOf(gone), out)
    }

    @Test
    fun toDeleteNeverTouchesManualDownloads() {
        val manualWatched = meta("m1", smart = false, watchedAt = now - 100 * hour)
        val manualUnselected = meta("m2", smart = false)
        val out = SmartDownloads.toDelete(listOf(manualWatched, manualUnselected), emptySet(), setOf("m1"), now)
        assertTrue(out.isEmpty())
    }

    @Test
    fun toAddExcludesExisting() {
        val a = ep(1, 1, 1, fileId = "a")
        val b = ep(1, 1, 2, fileId = "b")
        assertEquals(listOf(b), SmartDownloads.toAdd(listOf(a, b), setOf("a", "zzz")))
        assertEquals(listOf(a, b), SmartDownloads.toAdd(listOf(a, b), emptySet()))
    }
}
