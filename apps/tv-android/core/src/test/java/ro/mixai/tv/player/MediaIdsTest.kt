package ro.mixai.tv.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MediaIdsTest {
    private fun roundTrip(n: MusicNode) = assertEquals(n, MediaIds.decode(MediaIds.encode(n)))

    @Test fun everyNodeRoundTrips() {
        listOf(
            MusicNode.Root, MusicNode.Home, MusicNode.Playlists, MusicNode.Artists, MusicNode.Mix,
            MusicNode.Album("al_9f3"), MusicNode.Playlist("pl_3"), MusicNode.Artist("ar_x"), MusicNode.Radio("ar_x"),
            MusicNode.Track("tr_42", TrackContext.Album("al_9f3")),
            MusicNode.Track("tr_42", TrackContext.Playlist("pl_3")),
            MusicNode.Track("tr_42", TrackContext.Artist("ar_x")),
            MusicNode.Track("tr_42", TrackContext.MostPlayed),
            MusicNode.Track("tr_42", TrackContext.Single),
        ).forEach(::roundTrip)
    }

    @Test fun searchQueriesWithSeparatorsAndDiacriticsSurvive() {
        roundTrip(MusicNode.Track("tr_1", TrackContext.Search("AC/DC . Șase / ăîâ ?&=")))
        roundTrip(MusicNode.Album("weird/id.with.dots"))
    }

    @Test fun unknownOrIncompleteIdsDecodeToNullOrSingle() {
        assertNull(MediaIds.decode(null))
        assertNull(MediaIds.decode(""))
        assertNull(MediaIds.decode("album"))
        assertNull(MediaIds.decode("album/"))
        assertNull(MediaIds.decode("tr_42"))
        assertEquals(MusicNode.Track("tr_1", TrackContext.Single), MediaIds.decode("track/tr_1"))
        assertEquals(MusicNode.Track("tr_1", TrackContext.Single), MediaIds.decode("track/tr_1/zz.q"))
    }

    @Test fun startIndexFallsBackToZero() {
        assertEquals(2, MediaIds.startIndex(listOf("a", "b", "c"), "c"))
        assertEquals(0, MediaIds.startIndex(listOf("a", "b"), "zzz"))
        assertEquals(0, MediaIds.startIndex(emptyList(), "a"))
    }
}
