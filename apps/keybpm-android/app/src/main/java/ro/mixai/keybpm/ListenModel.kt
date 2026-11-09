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
        _ui.value = _ui.value.copy(listening = true, snapshot = null, micFailed = false, keyChange = null, tempoFactor = 1.0)
        poll = viewModelScope.launch(Dispatchers.Default) {
            while (isActive) {
                val s = engine?.snapshot() ?: break
                val change = if (s.keyChanged) s.key?.key?.camelot else null
                _ui.value = _ui.value.copy(snapshot = s, keyChange = change ?: _ui.value.keyChange)
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

    override fun onCleared() {
        stop()
    }

    private fun toLeBytes(block: FloatArray): ByteArray {
        val bb = ByteBuffer.allocate(block.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        bb.asFloatBuffer().put(block)
        return bb.array()
    }
}
