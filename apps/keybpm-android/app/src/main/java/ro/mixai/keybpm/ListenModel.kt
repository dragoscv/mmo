package ro.mixai.keybpm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import kotlinx.coroutines.flow.StateFlow
import ro.mixai.keybpm.data.SetLog
import uniffi.mixai_listen_ffi.KeyNotation
import uniffi.mixai_listen_ffi.ListenSnapshot

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
}
