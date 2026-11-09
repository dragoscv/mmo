package ro.mixai.keybpm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import kotlinx.coroutines.flow.StateFlow
import ro.mixai.keybpm.data.SetLog
import ro.mixai.keybpm.songid.SongMatch
import uniffi.mixai_listen_ffi.KeyNotation
import uniffi.mixai_listen_ffi.ListenSnapshot

/** Song ID (WP18-06) state for the live screen. */
sealed interface SongIdUi {
    data object Idle : SongIdUi
    /** Collecting audio before the first attempt (needs ~8 s). */
    data object Collecting : SongIdUi
    data object Matching : SongIdUi
    data class Found(
        val song: SongMatch,
        val libraryTrackId: String? = null,
        val libraryCamelot: String? = null,
        val libraryBpm: Double? = null,
        val queued: Boolean = false,
    ) : SongIdUi
    data object NoMatch : SongIdUi
    /** Offline: the fingerprint is kept and matched when the network is back. */
    data object Offline : SongIdUi
    data class Error(val reason: String) : SongIdUi
}

/** What the live screen renders. `snapshot` is null before the first reading. */
data class ListenUi(
    val listening: Boolean = false,
    val snapshot: ListenSnapshot? = null,
    /** User override of the tempo octave: 0.5, 1 or 2 (half/double button). */
    val tempoFactor: Double = 1.0,
    val notation: KeyNotation = KeyNotation.CAMELOT,
    val a4: Int = 440,
    val keyChange: String? = null,
    val micFailed: Boolean = false,
    /** File mode: display name of the analysed file, null in live mode. */
    val fileName: String? = null,
    val analysing: Boolean = false,
    val fileError: Boolean = false,
    /** Reading already saved to the set log for this listen/file. */
    val saved: Boolean = false,
    /** Wall clock when live listening started (stage mode set timer), null when idle. */
    val startedAtMillis: Long? = null,
    val songId: SongIdUi = SongIdUi.Idle,
    /** False on builds without the ShazamKit AAR. */
    val songIdAvailable: Boolean = false,
    val tracklistMode: Boolean = false,
    /** Fingerprints waiting for a network. */
    val pendingIds: Int = 0,
    val driftAlarm: Boolean = false,
    val driftReference: Double? = null,
    /** Current drift alert in percent (sustained), null when in range. */
    val drift: Double? = null,
    val announceKey: Boolean = false,
    val stageNight: Boolean = false,
    val stageDnd: Boolean = false,
) {
    /** BPM after the user's half/double override, null before a tempo reading. */
    val bpm: Double? get() = snapshot?.tempo?.let { it.bpm * tempoFactor }
}

/** UI facade over the process-wide [ListenSession] (which survives the activity so listening can continue in the background). */
class ListenModel(app: Application) : AndroidViewModel(app) {
    private val session = (app as KeyBpmApp).session
    val ui: StateFlow<ListenUi> = session.ui
    val log: SetLog = session.log

    fun start() = session.start()
    fun stop() = session.stop()
    fun again() = session.again()
    fun save() = session.save()
    fun deleteEntry(atMillis: Long) = session.deleteEntry(atMillis)
    fun clearLog() = session.clearLog()
    fun cycleTempo() = session.cycleTempo()
    fun setNotation(n: KeyNotation) = session.setNotation(n)
    fun setA4(hz: Int) = session.setA4(hz)
    fun dismissKeyChange() = session.dismissKeyChange()
    fun analyzeUri(uri: android.net.Uri) = session.analyzeUri(uri)
    fun clearFile() = session.clearFile()
    fun identify() = session.identify()
    fun setTracklistMode(on: Boolean) = session.setTracklistMode(on)
    fun addToQueue() = session.addFoundToQueue()
    fun setDriftAlarm(on: Boolean) = session.setDriftAlarm(on)
    fun setDriftReference() = session.setDriftReference()
    fun setAnnounceKey(on: Boolean) = session.setAnnounceKey(on)
    fun setStageNight(on: Boolean) = session.setStageNight(on)
    fun setStageDnd(on: Boolean) = session.setStageDnd(on)
    fun requestWhatKey() = session.requestWhatKey()
}
