package ro.mixai.decks.ui.engine

data class TracklistEntryUi(
    val id: String,
    val title: String,
    val artist: String,
    val isrc: String?,
    val deck: Int,
    val startSec: Double,
    val playedSec: Double,
)

enum class TracklistFormatUi(val extension: String) {
    TEXT("txt"), CUE("cue"), ORDA_UCMR_CSV("csv"), MIXCLOUD_SECTIONS("json"), M3U8("m3u8")
}

/** A recording in progress (FFI `SetRecorder`). */
interface SetRecording {
    val wavPath: String
    fun label(deck: Int, id: String, title: String, artist: String, isrc: String?, path: String?)
    fun observe()
    fun entries(): List<TracklistEntryUi>
    fun remove(index: Int)
    fun elapsedSec(): Double
    fun stop(): List<TracklistEntryUi>
}

/** Set recording + automatic tracklist (WP19-22). */
interface SetRecordPort {
    /** Start recording the master to [wavPath]; null when the engine refused (stopped, path). */
    fun start(wavPath: String): SetRecording?
    fun export(entries: List<TracklistEntryUi>, format: TracklistFormatUi, wavFile: String, title: String, dj: String): String
}
