package ro.mixai.decks.ui.engine

import ro.mixai.decks.ffi.DecksEngine
import ro.mixai.decks.ffi.SetRecorder
import ro.mixai.decks.ffi.SetTrackLabel
import ro.mixai.decks.ffi.TracklistEntry
import ro.mixai.decks.ffi.TracklistFormat
import ro.mixai.decks.ffi.tracklistExport

/** [SetRecordPort] over `decks-ffi` `SetRecorder`. */
class FfiSetRecord(private val engine: DecksEngine) : SetRecordPort {
    private fun TracklistEntry.ui() = TracklistEntryUi(id, title, artist, isrc, deck.toInt(), startSec, playedSec)
    private fun TracklistEntryUi.ffi() = TracklistEntry(id, title, artist, isrc, deck.toUByte(), startSec, playedSec)

    override fun start(wavPath: String): SetRecording? = runCatching {
        val r = SetRecorder.start(engine, wavPath)
        object : SetRecording {
            override val wavPath = wavPath
            override fun label(deck: Int, id: String, title: String, artist: String, isrc: String?, path: String?) {
                runCatching { r.setLabel(deck.toUByte(), SetTrackLabel(id, title, artist, isrc, path)) }
            }
            override fun observe() { runCatching { r.observe(engine) } }
            override fun entries() = runCatching { r.entries().map { it.ui() } }.getOrDefault(emptyList())
            override fun remove(index: Int) { runCatching { r.removeEntry(index.toUInt()) } }
            override fun elapsedSec() = runCatching { r.elapsedSec() }.getOrDefault(0.0)
            override fun stop() = runCatching { r.stop(engine).map { it.ui() } }.getOrDefault(emptyList())
        }
    }.onFailure { System.err.println("[decks] recording failed: $it") }.getOrNull()

    override fun export(entries: List<TracklistEntryUi>, format: TracklistFormatUi, wavFile: String, title: String, dj: String): String =
        runCatching {
            tracklistExport(
                entries.map { it.ffi() },
                when (format) {
                    TracklistFormatUi.TEXT -> TracklistFormat.TEXT
                    TracklistFormatUi.CUE -> TracklistFormat.CUE
                    TracklistFormatUi.ORDA_UCMR_CSV -> TracklistFormat.ORDA_UCMR_CSV
                    TracklistFormatUi.MIXCLOUD_SECTIONS -> TracklistFormat.MIXCLOUD_SECTIONS
                    TracklistFormatUi.M3U8 -> TracklistFormat.M3U8
                },
                wavFile, title, dj,
            )
        }.getOrDefault("")
}
