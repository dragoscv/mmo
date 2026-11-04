package ro.mixai.tv.ui.search

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import ro.mixai.tv.data.generated.LiveTvChannel
import ro.mixai.tv.data.generated.TitleCard
import ro.mixai.tv.ui.settings.moveNavItem
import ro.mixai.tv.ui.settings.subsonicTrackId
import ro.mixai.tv.ui.settings.toggleNavItem

class SearchLogicTest {
    @Test fun recentPushesNewestFirstDedupesAndCaps() {
        val start = (1..10).map { "q$it" }
        val next = RecentSearches.push(start, "Q3")
        assertEquals("Q3", next.first())
        assertEquals(10, next.size)
        assertEquals(1, next.count { it.equals("q3", ignoreCase = true) })
        // Re-pushing an existing query only moves it to the front: nothing is evicted.
        assertEquals("q10", next.last())
        // A new query at the cap drops the oldest one.
        val fresh = RecentSearches.push(start, "dune")
        assertEquals(listOf("dune") + (1..9).map { "q$it" }, fresh)
    }

    @Test fun foldStripsRomanianDiacritics() {
        assertEquals("stiri tvr", foldForSearch("Știri TVR"))
        assertEquals("antena", foldForSearch("Antenă"))
    }

    @Test fun channelMatchUsesAllWordsAndSkipsHidden() {
        val chans = listOf(
            LiveTvChannel(id = "1", name = "Pro TV HD", number = "2"),
            LiveTvChannel(id = "2", name = "Digi Sport 1"),
            LiveTvChannel(id = "3", name = "Pro Cinema", hidden = true),
            LiveTvChannel(id = "4", name = "Știrile Pro TV"),
        )
        assertEquals(listOf("1", "4"), matchChannels(chans, "pro tv").map { it.id })
        assertEquals(listOf("4"), matchChannels(chans, "stirile").map { it.id })
        assertEquals(emptyList<String>(), matchChannels(chans, "   ").map { it.id })
    }

    @Test fun splitByLibraryDropsPeopleAndPartitions() {
        val r = listOf(
            TitleCard(kind = "movie", tmdbId = 1, inLibrary = true),
            TitleCard(kind = "tv", tmdbId = 2, inLibrary = false),
            TitleCard(kind = "person", tmdbId = 3),
            TitleCard(kind = "movie", tmdbId = 4),
        )
        val (lib, rest) = splitByLibrary(r)
        assertEquals(listOf(1L), lib.map { it.tmdbId })
        assertEquals(listOf(2L, 4L), rest.map { it.tmdbId })
    }

    @Test fun navOrderMoveAndToggle() {
        val o = listOf("home", "search", "music", "settings")
        assertEquals(listOf("search", "home", "music", "settings"), moveNavItem(o, "search", -1))
        assertEquals(o, moveNavItem(o, "home", -1))
        assertEquals(listOf("home", "music", "settings"), toggleNavItem(o, "search"))
        assertEquals(o, toggleNavItem(o, "settings"))
        assertEquals(o + "livetv", toggleNavItem(o, "livetv"))
    }

    @Test fun trackKeysMapToSubsonicIds() {
        assertEquals("tr_42", subsonicTrackId("tr_42"))
        assertEquals("tr_42", subsonicTrackId("42"))
        assertEquals("tr_43", subsonicTrackId("srv1:track:43"))
        assertNull(subsonicTrackId("sha256:abcdef"))
    }
}
