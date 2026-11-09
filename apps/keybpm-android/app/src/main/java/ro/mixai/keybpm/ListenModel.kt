package ro.mixai.keybpm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import ro.mixai.keybpm.audio.MicCapture
import ro.mixai.keybpm.data.LogEntry
import ro.mixai.keybpm.data.SetLog
import uniffi.mixai_listen_ffi.EngineConfig
import uniffi.mixai_listen_ffi.KeyBpmEngine
import uniffi.mixai_listen_ffi.KeyNotation
import uniffi.mixai_listen_ffi.ListenSnapshot
import java.nio.ByteBuffer
import java.nio.ByteOrder

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
)

/**
 * Owns the Rust engine and the mic. The capture thread pushes 20 ms blocks; the UI polls a snapshot at ~20 Hz
 * (UniFFI calls stay on threads the app owns, no callbacks into Kotlin from Rust).
 */
class ListenModel(app: Application) : AndroidViewModel(app) {
    private val mic = MicCapture(app)
    private var engine: KeyBpmEngine? = null
    private var poll: Job? = null
    private val _ui = MutableStateFlow(ListenUi())
    val ui: StateFlow<ListenUi> = _ui.asStateFlow()
    val log = SetLog(app)

    init {
        viewModelScope.launch { log.load() }
    }

    fun start() {
        if (_ui.value.listening) return
        val e = KeyBpmEngine(EngineConfig(48_000u, 88.0, _ui.value.a4.toDouble()))
        val ok = mic.start { block -> engine?.pushPcmBytes(toLeBytes(block)) }
        if (!ok) {
            e.close()
            _ui.value = _ui.value.copy(micFailed = true)
            return
        }
        // Recreate with the real capture rate (48 or 44.1 kHz) before the first block is analysed.
        engine = if (mic.sampleRate == 48_000) e else {
            e.close()
            KeyBpmEngine(EngineConfig(mic.sampleRate.toUInt(), 88.0, _ui.value.a4.toDouble()))
        }
        _ui.value = _ui.value.copy(listening = true, snapshot = null, micFailed = false, keyChange = null, tempoFactor = 1.0, fileName = null, fileError = false, saved = false)
        poll = viewModelScope.launch(Dispatchers.Default) {
            while (isActive) {
                val s = engine?.snapshot() ?: break
                val change = if (s.keyChanged) s.key?.key?.camelot else null
                // A key change mid-set is a new song for the log.
                _ui.value = _ui.value.copy(snapshot = s, keyChange = change ?: _ui.value.keyChange, saved = _ui.value.saved && change == null)
                if (!_ui.value.saved && s.key?.locked == true && s.tempo?.locked == true) save("mic")
                delay(50)
            }
        }
    }

    /** Saves the current reading (auto on lock while listening, manual from the Save button / file mode). */
    fun save(source: String = if (_ui.value.fileName != null) "file" else "mic") {
        val u = _ui.value
        val k = u.snapshot?.key ?: return
        val t = u.snapshot.tempo ?: return
        _ui.value = u.copy(saved = true)
        viewModelScope.launch {
            log.add(LogEntry(System.currentTimeMillis(), k.key.camelot, k.key.name, t.bpm * u.tempoFactor, k.confidence, source, title = u.fileName))
        }
    }

    fun deleteEntry(atMillis: Long) {
        viewModelScope.launch { log.remove(atMillis) }
    }

    fun clearLog() {
        viewModelScope.launch { log.clear() }
    }

    fun stop() {
        mic.stop()
        poll?.cancel()
        poll = null
        engine?.close()
        engine = null
        _ui.value = _ui.value.copy(listening = false)
    }

    fun again() {
        stop()
        start()
    }

    fun cycleTempo() {
        val next = when (_ui.value.tempoFactor) { 1.0 -> 2.0; 2.0 -> 0.5; else -> 1.0 }
        _ui.value = _ui.value.copy(tempoFactor = next)
    }

    fun setNotation(n: KeyNotation) {
        _ui.value = _ui.value.copy(notation = n)
    }

    fun setA4(hz: Int) {
        val v = hz.coerceIn(415, 466)
        engine?.setA4(v.toDouble())
        _ui.value = _ui.value.copy(a4 = v)
    }

    fun dismissKeyChange() {
        _ui.value = _ui.value.copy(keyChange = null)
    }

    /** File mode: copy the picked document to cache (symphonia needs a path + extension) and analyse it. */
    fun analyzeUri(uri: android.net.Uri) {
        stop()
        val app = getApplication<Application>()
        val name = app.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: "audio"
        _ui.value = _ui.value.copy(analysing = true, fileName = name, snapshot = null, fileError = false, keyChange = null, saved = false)
        viewModelScope.launch(Dispatchers.IO) {
            val ext = name.substringAfterLast('.', "mp3").lowercase().take(5)
            val tmp = java.io.File(app.cacheDir, "analyse.$ext")
            val result = runCatching {
                app.contentResolver.openInputStream(uri)!!.use { input -> tmp.outputStream().use { input.copyTo(it) } }
                uniffi.mixai_listen_ffi.analyzeFile(tmp.absolutePath, 88.0)
            }
            tmp.delete()
            _ui.value = _ui.value.copy(
                analysing = false,
                snapshot = result.getOrNull(),
                fileError = result.isFailure,
            )
        }
    }

    fun clearFile() {
        _ui.value = _ui.value.copy(fileName = null, snapshot = null, fileError = false)
    }

    override fun onCleared() {
        stop()
    }

    private fun toLeBytes(block: FloatArray): ByteArray {
        val bb = ByteBuffer.allocate(block.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        bb.asFloatBuffer().put(block)
        return bb.array()
    }
}
