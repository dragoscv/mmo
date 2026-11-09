package ro.mixai.decks.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.DecksBackend
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.SetRecordPort
import ro.mixai.decks.ui.engine.SetRecording
import ro.mixai.decks.ui.engine.TracklistEntryUi
import ro.mixai.decks.ui.engine.TracklistFormatUi

private class FakeRecorder : SetRecordPort {
    val labels = mutableMapOf<Int, String>()
    var observed = 0
    var stopped = false
    val list = mutableListOf<TracklistEntryUi>()
    override fun start(wavPath: String): SetRecording? = if (wavPath.isEmpty()) null else object : SetRecording {
        override val wavPath = wavPath
        override fun label(deck: Int, id: String, title: String, artist: String, isrc: String?, path: String?) { labels[deck] = "$artist|$title" }
        override fun observe() {
            observed++
            if (list.isEmpty()) list += TracklistEntryUi("a", "Night Drive", "MixAI", null, 0, 0.0, 30.0)
        }
        override fun entries() = list.toList()
        override fun remove(index: Int) { list.removeAt(index) }
        override fun elapsedSec() = observed * 0.25
        override fun stop(): List<TracklistEntryUi> { stopped = true; return list.toList() }
    }
    override fun export(entries: List<TracklistEntryUi>, format: TracklistFormatUi, wavFile: String, title: String, dj: String) =
        "${format.name}:$wavFile:${entries.size}"
}

private class RBackend(val fake: FakeRecorder, inner: DecksBackend = DemoBackend { 0.0 }) : DecksBackend by inner {
    override fun setRecorder(): SetRecordPort = fake
}

class SetRecordTest {
    @Test fun demoEngineCannotRecord() {
        val ctl = DecksController(DemoBackend { 0.0 })
        assertFalse(ctl.startRecording("/tmp/x.wav"))
        assertTrue(ctl.recordError)
        assertEquals("", ctl.exportTracklist(TracklistFormatUi.CUE, "s", ""))
    }

    @Test fun recordingLabelsDecksBuildsTracklistAndExports() {
        val fake = FakeRecorder()
        val ctl = DecksController(RBackend(fake))
        ctl.startEngine()
        ctl.loadToDeck(0, DemoBackend.DEMO_TRACKS[0])
        repeat(12) { ctl.tick() }
        assertTrue(ctl.startRecording("/music/sets/set_1.wav"))
        assertEquals("MixAI|Night Drive", fake.labels[0])
        repeat(30) { ctl.tick() }
        assertTrue(fake.observed >= 2)
        assertEquals(1, ctl.tracklist.size)
        assertEquals("CUE:set_1.wav:1", ctl.exportTracklist(TracklistFormatUi.CUE, "s", ""))
        ctl.stopRecording()
        assertTrue(fake.stopped)
        assertFalse(ctl.recordingOn)
        assertEquals(1, ctl.tracklist.size, "kept after stop for export")
        ctl.removeTracklistEntry(0)
        assertTrue(ctl.tracklist.isEmpty())
    }
}
