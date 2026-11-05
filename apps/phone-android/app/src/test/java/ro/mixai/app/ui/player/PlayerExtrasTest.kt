package ro.mixai.app.ui.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ro.mixai.tv.data.MediaRef

class PlayerExtrasTest {
    // ─── night mode math ──────────────────────────────────────────────────
    @Test
    fun compressorLeavesQuietSignalWithMakeupGainOnly() {
        val g = NightMath.compressorGain(NightMath.dbToLin(-40.0))
        assertEquals(NightMath.dbToLin(NightMath.MAKEUP_DB), g, 1e-6)
    }

    @Test
    fun compressorReducesLoudSignalByRatio() {
        // -6 dBFS is 18 dB over the -24 threshold; 3:1 keeps 6 dB -> 12 dB reduction, +6 make-up = -6 dB gain.
        val g = NightMath.compressorGain(NightMath.dbToLin(-6.0))
        assertEquals(-6.0, NightMath.linToDb(g), 1e-6)
    }

    @Test
    fun boost51RaisesCentreAndLowersSurroundsAndLfe() {
        val f = doubleArrayOf(0.1, 0.1, 0.1, 0.1, 0.1, 0.1)
        NightMath.boost51(f)
        assertEquals(0.1, f[0], 1e-9)
        assertTrue(f[2] > 0.15)
        assertTrue(f[3] < 0.06)
        assertTrue(f[4] < 0.075 && f[5] < 0.075)
    }

    @Test
    fun boostStereoKeepsMonoCentredAndShrinksSide() {
        val mono = doubleArrayOf(0.2, 0.2)
        NightMath.boostStereo(mono)
        assertEquals(mono[0], mono[1], 1e-9)
        assertTrue(mono[0] > 0.2)
        val side = doubleArrayOf(0.2, -0.2)
        NightMath.boostStereo(side)
        assertTrue(kotlin.math.abs(side[0]) < 0.2)
    }

    @Test
    fun pcmClampsAndEnvelopeAttacksFasterThanReleases() {
        assertEquals(Short.MAX_VALUE, NightMath.toPcm16(2.0))
        assertEquals(Short.MIN_VALUE, NightMath.toPcm16(-2.0))
        val a = NightMath.coef(0.010, 48_000)
        val r = NightMath.coef(0.250, 48_000)
        val up = NightMath.envelope(0.0, 1.0, a, r)
        val down = NightMath.envelope(1.0, 0.0, a, r)
        assertTrue(up > 1.0 - down)
    }

    // ─── WebVTT (dual subtitles) ──────────────────────────────────────────
    private val vtt = """
        WEBVTT

        1
        00:00:01.000 --> 00:00:02.500 align:start
        <v Ana>Hello &amp; welcome</v>

        00:03.200 --> 00:04.000
        Second
        line

        bad --> cue
        ignored
    """.trimIndent()

    @Test
    fun vttParsesLongAndShortStampsStripsTagsAndEntities() {
        val cues = Vtt.parse(vtt)
        assertEquals(2, cues.size)
        assertEquals(1_000L, cues[0].startMs)
        assertEquals(2_500L, cues[0].endMs)
        assertEquals("Hello & welcome", cues[0].text)
        assertEquals(3_200L, cues[1].startMs)
        assertEquals("Second\nline", cues[1].text)
    }

    @Test
    fun vttActiveTextFindsCueAndGaps() {
        val cues = Vtt.parse(vtt)
        assertNull(Vtt.activeText(cues, 500L))
        assertEquals("Hello & welcome", Vtt.activeText(cues, 1_500L))
        assertNull(Vtt.activeText(cues, 2_800L))
        assertEquals("Second\nline", Vtt.activeText(cues, 3_999L))
        assertNull(Vtt.activeText(cues, 4_000L))
        assertNull(Vtt.activeText(emptyList(), 1L))
    }

    @Test
    fun vttTimeVariants() {
        assertEquals(3_723_400L, Vtt.parseTime("01:02:03.4"))
        assertEquals(61_050L, Vtt.parseTime("01:01,05"))
        assertNull(Vtt.parseTime("nope"))
    }

    // ─── data saver ───────────────────────────────────────────────────────
    @Test
    fun dataSaverAsksOnlyOnMeteredWithoutOverrideOrDownload() {
        assertTrue(shouldAskCellular(NetKind.Metered, dataSaver = true, titleAllowed = false, hasOfflineCopy = false))
        assertFalse(shouldAskCellular(NetKind.Unmetered, true, false, false))
        assertFalse(shouldAskCellular(NetKind.Metered, false, false, false))
        assertFalse(shouldAskCellular(NetKind.Metered, true, true, false))
        assertFalse(shouldAskCellular(NetKind.Metered, true, false, true))
        assertFalse(shouldAskCellular(NetKind.None, true, false, false))
        assertEquals("movie:603", cellularKey("movie", 603L, "f1"))
        assertEquals("file:f1", cellularKey(null, null, "f1"))
    }

    // ─── bookmarks keys ───────────────────────────────────────────────────
    @Test
    fun bookmarkKeysMatchServerTitleKeys() {
        assertEquals("file:abc", bookmarkKey(null, "abc"))
        assertEquals("movie:603", bookmarkKey(MediaRef("movie", 603), "abc"))
        assertEquals("tv:1399:s1e2", bookmarkKey(MediaRef("tv", 1399, 1, 2), "abc"))
        assertEquals("tv:1399", bookmarkKey(MediaRef("tv", 1399), "abc"))
        val inMovie = bookmarkInput(MediaRef("movie", 603), "abc", 12.5, "", true)
        assertEquals(603L, inMovie.tmdbId)
        assertNull(inMovie.fileId)
        assertNull(inMovie.label)
        val inFile = bookmarkInput(null, "abc", 1.0, "x", false)
        assertEquals("abc", inFile.fileId)
    }
}
