package ro.mixai.keybpm

import android.app.Application
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
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
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Process-wide live session (WP18-18): engine + mic + snapshot poll live here, not in the ViewModel, so listening
 * keeps going with the screen off or another app in front. [ListenService] holds the process in the foreground
 * (type microphone) while [ListenUi.listening] is true and mirrors the reading in an ongoing notification.
 */
class ListenSession(private val app: Application) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val mic = MicCapture(app)
    @Volatile private var engine: KeyBpmEngine? = null
    private var poll: Job? = null
    private val _ui = MutableStateFlow(ListenUi())
    val ui: StateFlow<ListenUi> = _ui.asStateFlow()
    val log = SetLog(app)

    init {
        scope.launch { log.load() }
    }

    /** Caller must hold RECORD_AUDIO and be in the foreground (FGS microphone start rule). */
    fun start() {
        if (_ui.value.listening) return
        val e = KeyBpmEngine(EngineConfig(48_000u, 88.0, _ui.value.a4.toDouble()))
        engine = e
        val ok = mic.start { block -> engine?.pushPcmBytes(toLeBytes(block)) }
        if (!ok) {
            engine = null
            e.close()
            _ui.value = _ui.value.copy(micFailed = true)
            return
        }
        // Recreate with the real capture rate (48 or 44.1 kHz) before the first block is analysed.
        if (mic.sampleRate != 48_000) {
            engine = KeyBpmEngine(EngineConfig(mic.sampleRate.toUInt(), 88.0, _ui.value.a4.toDouble()))
            e.close()
        }
        _ui.value = _ui.value.copy(
            listening = true, snapshot = null, micFailed = false, keyChange = null, tempoFactor = 1.0,
            fileName = null, fileError = false, saved = false, startedAtMillis = System.currentTimeMillis(),
        )
        ContextCompat.startForegroundService(app, ListenService.intent(app))
        poll = scope.launch {
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

    fun stop() {
        mic.stop()
        poll?.cancel()
        poll = null
        engine?.close()
        engine = null
        _ui.value = _ui.value.copy(listening = false, startedAtMillis = null)
        app.stopService(ListenService.intent(app))
    }

    fun again() {
        stop()
        start()
    }

    /** Saves the current reading (auto on lock while listening, manual from the Save button / file mode). */
    fun save(source: String = if (_ui.value.fileName != null) "file" else "mic") {
        val u = _ui.value
        val k = u.snapshot?.key ?: return
        val t = u.snapshot.tempo ?: return
        _ui.value = u.copy(saved = true)
        scope.launch {
            log.add(LogEntry(System.currentTimeMillis(), k.key.camelot, k.key.name, t.bpm * u.tempoFactor, k.confidence, source, title = u.fileName))
        }
    }

    fun deleteEntry(atMillis: Long) {
        scope.launch { log.remove(atMillis) }
    }

    fun clearLog() {
        scope.launch { log.clear() }
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
        _ui.value = _ui.value.copy(keyChange = null, micFailed = false)
    }

    /** File mode: copy the picked document to cache (symphonia needs a path + extension) and analyse it. */
    fun analyzeUri(uri: android.net.Uri) {
        stop()
        val name = app.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: "audio"
        _ui.value = _ui.value.copy(analysing = true, fileName = name, snapshot = null, fileError = false, keyChange = null, saved = false)
        scope.launch(Dispatchers.IO) {
            val ext = name.substringAfterLast('.', "mp3").lowercase().take(5)
            val tmp = java.io.File(app.cacheDir, "analyse.$ext")
            val result = runCatching {
                app.contentResolver.openInputStream(uri)!!.use { input -> tmp.outputStream().use { input.copyTo(it) } }
                uniffi.mixai_listen_ffi.analyzeFile(tmp.absolutePath, 88.0)
            }
            tmp.delete()
            _ui.value = _ui.value.copy(analysing = false, snapshot = result.getOrNull(), fileError = result.isFailure)
        }
    }

    fun clearFile() {
        _ui.value = _ui.value.copy(fileName = null, snapshot = null, fileError = false)
    }

    private fun toLeBytes(block: FloatArray): ByteArray {
        val bb = ByteBuffer.allocate(block.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        bb.asFloatBuffer().put(block)
        return bb.array()
    }
}
