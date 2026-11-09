package ro.mixai.keybpm.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

class TracklistExportTest {
    private val a = LogEntry(1_700_000_000_000, "8A", "A minor", 124.04, 0.9, "mic", title = "Levels", artist = "Avicii", libraryPath = "/music/Avicii - Levels.flac")
    private val b = LogEntry(1_700_000_245_000, "9A", "E minor", 126.0, 0.8, "mic")
    private val c = LogEntry(1_700_003_700_000, "10B", "D major", 128.0, 0.7, "mic", title = "Tom & \"Jerry\" <x>", artist = "A")

    @Test
    fun textTracklistIsSetOrderWithOffsetsAndIdPlaceholders() {
        val t = TracklistExport.text(listOf(c, b, a)).trimEnd().lines()
        assertEquals("01. [0:00] Avicii – Levels (8A · 124)", t[0])
        assertEquals("02. [4:05] ID – ID (9A · 126)", t[1])
        assertEquals("03. [1:01:40] A – Tom & \"Jerry\" <x> (10B · 128)", t[2])
    }

    @Test
    fun m3u8HasExtinfAndLibraryPathOnlyWhenKnown() {
        val m = TracklistExport.m3u8(listOf(b, a)).lines()
        assertEquals("#EXTM3U", m[0])
        assertEquals("#EXTINF:-1,Avicii – Levels", m[1])
        assertEquals("/music/Avicii - Levels.flac", m[2])
        assertEquals("#EXTINF:-1,ID (9A · 126 BPM)", m[3])
        assertEquals("# not in library", m[4])
    }

    @Test
    fun rekordboxXmlIsEscapedAndListsPlaylistInOrder() {
        val x = TracklistExport.rekordboxXml(listOf(c, a), "Set & co", ZoneOffset.UTC)
        assertTrue(x.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<DJ_PLAYLISTS Version=\"1.0.0\">"))
        assertTrue(x.contains("<COLLECTION Entries=\"2\">"))
        assertTrue(x.contains("TrackID=\"1\" Name=\"Levels\" Artist=\"Avicii\" AverageBpm=\"124.04\" Tonality=\"8A\" DateAdded=\"2023-11-14\""))
        assertTrue(x.contains("Location=\"file://localhost/music/Avicii%20-%20Levels.flac\""))
        assertTrue(x.contains("Name=\"Tom &amp; &quot;Jerry&quot; &lt;x&gt;\""))
        assertTrue(x.contains("<NODE Name=\"Set &amp; co\" Type=\"1\" KeyType=\"0\" Entries=\"2\">"))
        assertFalse(x.contains("<x>"))
        assertTrue(x.indexOf("<TRACK Key=\"1\"/>") < x.indexOf("<TRACK Key=\"2\"/>"))
    }

    @Test
    fun sameSongByIsrcOrTitleArtist() {
        val x = a.copy(isrc = "SE123")
        assertTrue(SetLog.sameSong(x, b.copy(isrc = "se123")))
        assertTrue(SetLog.sameSong(a, b.copy(title = "levels", artist = "AVICII")))
        assertFalse(SetLog.sameSong(a, b))
        assertFalse(SetLog.sameSong(a.copy(source = "file"), a))
    }
}
