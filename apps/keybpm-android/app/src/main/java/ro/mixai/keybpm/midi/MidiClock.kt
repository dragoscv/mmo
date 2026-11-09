package ro.mixai.keybpm.midi

import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.midi.MidiDevice
import android.media.midi.MidiDeviceInfo
import android.media.midi.MidiInputPort
import android.media.midi.MidiManager
import android.os.Handler
import android.os.Looper
import android.os.Process
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin

data class MidiOut(val id: Int, val name: String)

data class ClockState(
    val running: Boolean = false,
    val bpm: Double = 120.0,
    val outputs: List<MidiOut> = emptyList(),
    val connected: MidiOut? = null,
    val click: Boolean = false,
    /** Beat counter (quarter notes since start), drives the visual metronome. */
    val beat: Long = 0,
    val midiAvailable: Boolean = false,
)

/**
 * MIDI clock out (WP18-08): Start (0xFA), 24 ppqn Clock (0xF8) on a URGENT_AUDIO thread with nanoTime deadlines,
 * Stop (0xFC). Sends to the input port of a USB/BLE MIDI device (drum machine, CDJ/mixer with clock in, DAW over
 * USB). BPM follows the detected tempo or the user's tap tempo; changing it while running keeps the phase. An
 * optional click (AudioTrack, 1 kHz on the downbeat, 800 Hz otherwise) is the metronome. No Ableton Link (D69).
 */
class MidiClock(private val context: Context) {
    private val manager: MidiManager? =
        if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_MIDI)) context.getSystemService(MidiManager::class.java) else null
    private val _state = MutableStateFlow(ClockState(midiAvailable = manager != null))
    val state: StateFlow<ClockState> = _state.asStateFlow()
    private var device: MidiDevice? = null
    private var port: MidiInputPort? = null
    @Volatile private var tickNanos = TempoMath.tickNanos(120.0)
    @Volatile private var running = false
    private var thread: Thread? = null
    private val callbackExecutor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var clicks: Clicks? = null

    private val deviceCallback = object : MidiManager.DeviceCallback() {
        override fun onDeviceAdded(device: MidiDeviceInfo) = refresh()
        override fun onDeviceRemoved(device: MidiDeviceInfo) {
            if (_state.value.connected?.id == device.id) disconnect()
            refresh()
        }
    }

    fun watch() {
        val m = manager ?: return
        m.registerDeviceCallback(MidiManager.TRANSPORT_MIDI_BYTE_STREAM, callbackExecutor, deviceCallback)
        refresh()
    }

    fun unwatch() {
        manager?.unregisterDeviceCallback(deviceCallback)
    }

    private fun refresh() {
        val m = manager ?: return
        val outs = m.getDevicesForTransport(MidiManager.TRANSPORT_MIDI_BYTE_STREAM)
            .filter { it.inputPortCount > 0 }
            .map { info ->
                val p = info.properties
                val name = listOfNotNull(p.getString(MidiDeviceInfo.PROPERTY_MANUFACTURER), p.getString(MidiDeviceInfo.PROPERTY_PRODUCT))
                    .joinToString(" ").ifBlank { p.getString(MidiDeviceInfo.PROPERTY_NAME) ?: "MIDI ${info.id}" }
                MidiOut(info.id, name)
            }
        _state.value = _state.value.copy(outputs = outs)
    }

    fun connect(out: MidiOut) {
        val m = manager ?: return
        val info = m.getDevicesForTransport(MidiManager.TRANSPORT_MIDI_BYTE_STREAM).firstOrNull { it.id == out.id } ?: return
        disconnect()
        m.openDevice(info, { d ->
            if (d == null) return@openDevice
            device = d
            port = d.openInputPort(0)
            _state.value = _state.value.copy(connected = out)
            if (running) send(START)
        }, main)
    }

    fun disconnect() {
        if (running) send(STOP)
        runCatching { port?.close() }
        runCatching { device?.close() }
        port = null
        device = null
        _state.value = _state.value.copy(connected = null)
    }

    fun setBpm(bpm: Double) {
        val v = bpm.coerceIn(TempoMath.MIN_BPM, TempoMath.MAX_BPM)
        tickNanos = TempoMath.tickNanos(v)
        _state.value = _state.value.copy(bpm = v)
    }

    fun setClick(on: Boolean) {
        _state.value = _state.value.copy(click = on)
    }

    fun start() {
        if (running) return
        running = true
        clicks = Clicks().also { it.open() }
        _state.value = _state.value.copy(running = true, beat = 0)
        thread = Thread({
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
            send(START)
            var tick = 0L
            var next = System.nanoTime()
            while (running) {
                if (tick % TempoMath.PPQN == 0L) {
                    val beat = tick / TempoMath.PPQN
                    if (_state.value.click) clicks?.play(beat % 4 == 0L)
                    _state.value = _state.value.copy(beat = beat)
                }
                send(CLOCK)
                tick++
                next += tickNanos
                val wait = next - System.nanoTime()
                if (wait > 0) Thread.sleep(wait / 1_000_000, (wait % 1_000_000).toInt())
                else if (wait < -50_000_000) next = System.nanoTime() // fell > 50 ms behind (device stall): resync
            }
            send(STOP)
        }, "keybpm-midi-clock").apply { start() }
    }

    fun stop() {
        running = false
        thread?.join(500)
        thread = null
        clicks?.close()
        clicks = null
        _state.value = _state.value.copy(running = false)
    }

    private fun send(b: Byte) {
        val p = port ?: return
        runCatching { p.send(byteArrayOf(b), 0, 1) }
    }

    /** Two pre-rendered 30 ms clicks played through a static AudioTrack each. */
    private class Clicks {
        private var hi: AudioTrack? = null
        private var lo: AudioTrack? = null

        fun open() {
            hi = track(1_000.0)
            lo = track(800.0)
        }

        fun play(downbeat: Boolean) {
            val t = (if (downbeat) hi else lo) ?: return
            runCatching { t.stop(); t.reloadStaticData(); t.play() }
        }

        fun close() {
            hi?.release(); lo?.release()
            hi = null; lo = null
        }

        private fun track(freq: Double): AudioTrack? = runCatching {
            val rate = 48_000
            val n = rate * 30 / 1000
            val pcm = ShortArray(n) { i ->
                val t = i.toDouble() / rate
                (sin(2 * PI * freq * t) * exp(-t * 150) * Short.MAX_VALUE * 0.6).toInt().toShort()
            }
            AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(n * 2)
                .build()
                .also { it.write(pcm, 0, n) }
        }.getOrNull()
    }

    companion object {
        private const val START: Byte = 0xFA.toByte()
        private const val STOP: Byte = 0xFC.toByte()
        private const val CLOCK: Byte = 0xF8.toByte()
    }
}
