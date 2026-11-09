package ro.mixai.keybpm.wear

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Haptic beat on the wrist (WP18-04, opt-in): a tick on every beat, a click on the downbeat (every 4th), driven by
 * [WearListen.clock] on its own high-priority thread. USAGE_MEDIA so it keeps going while the microphone foreground
 * service holds the process with the screen off. Also the accessibility "feel the key change" double buzz.
 */
class BeatHaptics(context: Context, private val session: WearListen) {
    private val vibrator: Vibrator? = context.getSystemService(VibratorManager::class.java)?.defaultVibrator?.takeIf { it.hasVibrator() }
    private val thread = HandlerThread("keybpm-haptics", Process.THREAD_PRIORITY_URGENT_DISPLAY).apply { start() }
    private val handler = Handler(thread.looper)
    private val attrs = VibrationAttributes.Builder().setUsage(VibrationAttributes.USAGE_MEDIA).build()
    private val tick = VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK)
    private val accent = VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK)
    @Volatile private var running = false

    private val beat = object : Runnable {
        override fun run() {
            if (!running) return
            val now = SystemClock.uptimeMillis().toDouble()
            val wait = session.clock.untilNext(now)
            if (wait == null) { running = false; return }
            if (wait <= 4) {
                val i = session.clock.consume()
                vibrator?.vibrate(if (i % 4 == 0L) accent else tick, attrs)
                schedule()
            } else {
                handler.postAtTime(this, (now + wait).toLong())
            }
        }
    }

    private fun schedule() {
        val wait = session.clock.untilNext(SystemClock.uptimeMillis().toDouble()) ?: return
        handler.postAtTime(beat, SystemClock.uptimeMillis() + wait.toLong())
    }

    /** Starts or stops the beat to match the session (haptics on + a source or tap tempo + a running clock). */
    fun sync() {
        val u = session.ui.value
        val want = vibrator != null && u.haptics && (u.active || u.tapBpm != null) && session.clock.running
        if (want == running) return
        running = want
        handler.removeCallbacks(beat)
        if (want) handler.post(beat)
    }

    /** Key-change cue: two strong pulses (works without the beat haptics, for hard-of-hearing / eyes-off use). */
    fun keyChange() {
        val v = vibrator ?: return
        v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 60, 90, 60), intArrayOf(0, 255, 0, 255), -1), attrs)
    }
}
