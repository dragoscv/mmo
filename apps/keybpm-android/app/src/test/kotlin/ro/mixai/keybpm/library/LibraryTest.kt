package ro.mixai.keybpm.library

import org.junit.Assert.assertEquals
import org.junit.Test

class LibraryTest {
    @Test
    fun buildsTheCompatibleQueryWithoutLocaleCommas() {
        assertEquals("/media/music/compatible?key=8A&bpm=124.50&limit=30", Library.path("8A", 124.5))
        assertEquals("/media/music/compatible?bpm=90.00&limit=10", Library.path(null, 90.0, 10))
    }

    @Test
    fun parsesTheServerResponseAndIgnoresUnknownFields() {
        val body = """{"key":"8A","bpm":124,"tracks":[{"id":"tr_7","title":"One More Time","artist":"Daft Punk",
            "bpm":122.9,"keyCamelot":"8A","score":0.97,"plays":3,"coverArt":"al_x","durationSec":320.5}]}"""
        val r = Library.parse(body)
        assertEquals("8A", r.key)
        assertEquals(1, r.tracks.size)
        assertEquals("tr_7", r.tracks[0].id)
        assertEquals(0.97, r.tracks[0].score, 1e-9)
    }

    @Test
    fun playLinkMatchesTheMusicAppSet() {
        assertEquals("mixai-music://play?ids=tr_7&index=0", Library.playLink("tr_7"))
    }
}
