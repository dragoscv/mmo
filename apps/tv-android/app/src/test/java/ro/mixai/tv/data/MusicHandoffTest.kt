package ro.mixai.tv.data

import org.junit.Assert.assertEquals
import org.junit.Test

class MusicHandoffTest {
    @Test fun emptyQueueOpensMusicHome() {
        assertEquals("mixai-music://home", MusicHandoff.url())
        assertEquals("mixai-music://home", MusicHandoff.url(listOf(" ", "")))
    }

    @Test fun queueBecomesCanonicalPlayLinkWithClampedIndex() {
        assertEquals("mixai-music://play?ids=tr_1,tr_2&index=1", MusicHandoff.url(listOf("tr_1", "tr_2"), 1))
        assertEquals("mixai-music://play?ids=tr_1,tr_2&index=1", MusicHandoff.url(listOf("tr_1", "tr_2"), 7))
        assertEquals("mixai-music://play?ids=tr_1&index=0", MusicHandoff.url(listOf("tr_1"), -2))
    }

    @Test fun idsAreEncodedAndCommaIdsDropped() {
        assertEquals("mixai-music://play?ids=a%20b,c%2Fd&index=0", MusicHandoff.url(listOf("a b", "x,y", "c/d")))
    }
}
