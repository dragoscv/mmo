package ro.mixai.keybpm.wear

import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.wear.tiles.TileService
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
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
import ro.mixai.listen.BeatClock
import ro.mixai.listen.MicCapture
import ro.mixai.listen.TempoMath
import ro.mixai.listen.WearLink
import uniffi.mixai_listen_ffi.EngineConfig
import uniffi.mixai_listen_ffi.KeyBpmEngine
import java.nio.ByteBuffer
import java.nio.ByteOrder

enum class Source { NONE, WATCH, PHONE }

data class WearUi(
    val source: Source = Source.NONE,
    val keyIndex: Int? = null,
    val keyLocked: Boolean = false,
    val bpm: Double? = null,
    val tempoLocked: Boolean = false,
    /** Wrist-tap override (replaces the detected BPM until cleared). */
    val tapBpm: Double? = null,
    val levelLow: Boolean = false,
    val micFailed: Boolean = false,
    val phoneListening: Boolean = false,
    val title: String? = null,
    val haptics: Boolean = false,
    val keyChange: Int? = null,
) {
    val shownBpm: Double? get() = tapBpm ?: bpm
    val active: Boolean get() = source != Source.NONE
}

/**
 * Process-wide watch session. Two sources, one UI: [startWatch] runs the Rust engine on the watch mic (needs the
 * activity in front to start the microphone foreground service); [onPhone] mirrors the phone while it listens and
 * the watch is not listening itself. Haptic beat follows whichever source is active (+ wrist tap override).
 */
class WearListen(private val app: Application) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val mic = MicCapture(app)
    @Volatile private var engine: KeyBpmEngine? = null
    private var poll: Job? = null
    private var phoneTimeout: Job? = null
    private val _ui = MutableStateFlow(WearUi(haptics = LastReading.haptics(app)))
    val ui: StateFlow<WearUi> = _ui.asStateFlow()
    val clock = BeatClock()
    private val taps = ArrayList<Long>()
    val haptics = BeatHaptics(app, this)

    fun startWatch() {
        if (_ui.value.source == Source.WATCH) return
        val e = KeyBpmEngine(EngineConfig(48_000u, 88.0, 440.0))
        engine = e
        val ok = mic.start { block -> engine?.pushPcmBytes(toLeBytes(block)) }
        if (!ok) {
            engine = null
            e.close()
            _ui.value = _ui.value.copy(micFailed = true)
            return
        }
        if (mic.sampleRate != 48_000) {
            engine = KeyBpmEngine(EngineConfig(mic.sampleRate.toUInt(), 88.0, 440.0))
            e.close()
        }
        clock.stop()
        _ui.value = _ui.value.copy(source = Source.WATCH, keyIndex = null, bpm = null, keyLocked = false, tempoLocked = false, micFailed = false, tapBpm = null, title = null, keyChange = null)
        ContextCompat.startForegroundService(app, WearListenService.intent(app))
        poll = scope.launch {
            var lastKey: Int? = null
            while (isActive) {
                val s = engine?.snapshot() ?: break
                val k = s.key
                val t = s.tempo
                val idx = k?.key?.index?.toInt()
                val change = if (s.keyChanged && idx != null && lastKey != null && idx != lastKey) idx else null
                if (idx != null) lastKey = idx
                if (t != null && _ui.value.tapBpm == null) clock.update(t.bpm, t.nextBeatInSecs * 1000, now())
                _ui.value = _ui.value.copy(
                    keyIndex = idx, keyLocked = k?.locked == true, bpm = t?.bpm, tempoLocked = t?.locked == true,
                    levelLow = s.levelDbfs < -55, keyChange = change ?: _ui.value.keyChange,
                )
                if (change != null) haptics.keyChange()
                if (k?.locked == true && t?.locked == true) LastReading.save(app, idx, t.bpm)
                haptics.sync()
                delay(100)
            }
        }
        haptics.sync()
        refreshSurfaces()
    }

    fun stopWatch() {
        mic.stop()
        poll?.cancel()
        poll = null
        engine?.close()
        engine = null
        clock.stop()
        _ui.value = _ui.value.copy(source = if (_ui.value.phoneListening) Source.PHONE else Source.NONE)
        app.stopService(WearListenService.intent(app))
        haptics.sync()
        refreshSurfaces()
    }

    /** Live reading from the phone (MessageClient). Ignored while the watch listens itself. */
    fun onPhone(r: WearLink.Reading) {
        phoneTimeout?.cancel()
        val cur = _ui.value
        if (!r.listening) {
            _ui.value = cur.copy(phoneListening = false, source = if (cur.source == Source.PHONE) Source.NONE else cur.source)
            if (cur.source == Source.PHONE) { clock.stop(); haptics.sync() }
            return
        }
        // No message for 6 s (two missed heartbeats) = phone gone.
        phoneTimeout = scope.launch { delay(6_000); onPhone(WearLink.Reading(listening = false)) }
        if (cur.source == Source.WATCH) { _ui.value = cur.copy(phoneListening = true); return }
        val change = if (cur.source == Source.PHONE && r.keyIndex != null && cur.keyIndex != null && r.keyIndex != cur.keyIndex && r.keyLocked) r.keyIndex else null
        val rBpm = r.bpm
        val rNext = r.nextBeatMs
        if (rBpm != null && rNext != null && cur.tapBpm == null) {
            // Correct for message latency using the sender clock (both clocks are NTP-synced to within ~50 ms).
            val age = (System.currentTimeMillis() - r.atMillis).coerceIn(0, 2_000)
            clock.update(rBpm, (rNext - age).toDouble().let { if (it < 0) it.mod(60_000.0 / rBpm) else it }, now())
        }
        _ui.value = cur.copy(
            source = Source.PHONE, phoneListening = true, keyIndex = r.keyIndex, keyLocked = r.keyLocked, bpm = r.bpm,
            tempoLocked = r.tempoLocked, title = r.title, keyChange = change ?: cur.keyChange, levelLow = false,
        )
        if (change != null) haptics.keyChange()
        haptics.sync()
        if (r.keyLocked && r.tempoLocked) LastReading.save(app, r.keyIndex, r.bpm)
        if (cur.source != Source.PHONE) refreshSurfaces()
    }

    /** Wrist tap tempo: two or more taps set the beat (and phase: the beat lands on the last tap). */
    fun tap() {
        val t = now().toLong()
        taps.add(t)
        while (taps.size > 12) taps.removeAt(0)
        val bpm = TempoMath.tapBpm(taps) ?: return
        clock.update(bpm, 60_000.0 / bpm, t.toDouble())
        _ui.value = _ui.value.copy(tapBpm = bpm)
        haptics.sync()
    }

    fun clearTap() {
        taps.clear()
        _ui.value = _ui.value.copy(tapBpm = null)
        if (_ui.value.bpm == null) clock.stop()
    }

    fun setHaptics(on: Boolean) {
        LastReading.setHaptics(app, on)
        _ui.value = _ui.value.copy(haptics = on)
        haptics.sync()
    }

    fun dismissKeyChange() {
        _ui.value = _ui.value.copy(keyChange = null, micFailed = false)
    }

    fun refreshSurfaces() {
        refreshSurfaces(app)
    }

    private fun now(): Double = SystemClock.uptimeMillis().toDouble()

    private fun toLeBytes(block: FloatArray): ByteArray {
        val bb = ByteBuffer.allocate(block.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        bb.asFloatBuffer().put(block)
        return bb.array()
    }

    companion object {
        /** Tile + complication re-read [LastReading] (throttled by the system; call on state changes only). */
        fun refreshSurfaces(ctx: Context) {
            runCatching { TileService.getUpdater(ctx).requestUpdate(KeyBpmTileService::class.java) }
            runCatching {
                ComplicationDataSourceUpdateRequester.create(ctx, ComponentName(ctx, KeyBpmComplicationService::class.java)).requestUpdateAll()
            }
        }
    }
}

/** Last locked reading for the tile + complication (watch or phone), plus the haptics preference. */
object LastReading {
    private const val PREFS = "keybpm_wear"

    data class Value(val keyIndex: Int?, val bpm: Double?, val atMillis: Long)

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun get(ctx: Context): Value {
        val p = prefs(ctx)
        return Value(
            p.getInt("key", -1).takeIf { it >= 0 },
            p.getFloat("bpm", 0f).toDouble().takeIf { it > 0 },
            p.getLong("at", 0),
        )
    }

    private var lastSavedKey: Int? = null
    private var lastSavedBpm = 0.0

    /** Writes only when the value really changed (≥ 0.5 BPM or another key) and then refreshes the surfaces. */
    fun save(ctx: Context, keyIndex: Int?, bpm: Double?) {
        if (keyIndex == lastSavedKey && bpm != null && kotlin.math.abs(bpm - lastSavedBpm) < 0.5) return
        lastSavedKey = keyIndex
        lastSavedBpm = bpm ?: 0.0
        prefs(ctx).edit()
            .putInt("key", keyIndex ?: -1)
            .putFloat("bpm", (bpm ?: 0.0).toFloat())
            .putLong("at", System.currentTimeMillis())
            .apply()
        WearListen.refreshSurfaces(ctx)
    }

    fun haptics(ctx: Context): Boolean = prefs(ctx).getBoolean("haptics", false)
    fun setHaptics(ctx: Context, on: Boolean) = prefs(ctx).edit().putBoolean("haptics", on).apply()
}
