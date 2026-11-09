package ro.mixai.keybpm.songid

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SongIdTest {
    @Test
    fun ringKeepsTheMostRecentAudioAsLittleEndianPcm16() {
        val r = PcmRing(sampleRate = 4, seconds = 1) // 4 samples capacity
        r.push(floatArrayOf(0f, 1f, -1f))
        r.push(floatArrayOf(0.5f, 0.25f))
        assertEquals(1.0, r.filledSeconds, 1e-9)
        val out = r.snapshot()
        // Oldest dropped: 1, -1, 0.5, 0.25
        fun le(v: Int) = byteArrayOf((v and 0xFF).toByte(), ((v shr 8) and 0xFF).toByte())
        assertArrayEquals(le(32767) + le(-32767) + le(16383) + le(8191), out)
        assertEquals(4, r.snapshot(maxSeconds = 0.5).size)
    }

    @Test
    fun libraryMatchingIgnoresCaseAccentsFeaturingAndMixSuffix() {
        assertTrue(LibraryMatching.matches("Strobe", "deadmau5", "Strobe (Original Mix)", "Deadmau5"))
        assertTrue(LibraryMatching.matches("Dragostea Din Tei", "O-Zone", "Dragostea din tei", "O‑Zone"))
        assertTrue(LibraryMatching.matches("Titanium (feat. Sia)", "David Guetta", "Titanium", "David Guetta & Sia"))
        assertTrue(LibraryMatching.matches("Sânge de român", null, "Sange de roman", "Fără Zahăr"))
        assertFalse(LibraryMatching.matches("Strobe", "deadmau5", "Ghosts n Stuff", "deadmau5"))
        assertFalse(LibraryMatching.matches("Intro", "Artist A", "Intro", "Totally Different"))
    }

    @Test
    fun outboundLinksAreSearchUrls() {
        val m = SongMatch(title = "Levels", artist = "Avicii")
        assertEquals("https://open.spotify.com/search/Avicii%20Levels", SongLinks.spotify(m))
        assertEquals("https://music.youtube.com/search?q=Avicii+Levels", SongLinks.youtubeMusic(m))
    }
}
