package ro.mixai.keybpm

import android.content.Context
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * Accessibility cues (WP18 round 2): spoken "Key now A minor" + a double buzz on a key change, a long buzz on a
 * tempo drift alarm. TTS is created lazily on the first announcement and uses the app language.
 */
class KeyAnnouncer(private val context: Context) {
    private var tts: TextToSpeech? = null
    private var ready = false
    private var pending: String? = null
    private val vibrator = context.getSystemService(VibratorManager::class.java)?.defaultVibrator?.takeIf { it.hasVibrator() }
    private val attrs = VibrationAttributes.Builder().setUsage(VibrationAttributes.USAGE_ACCESSIBILITY).build()

    fun keyChanged(keyName: String) {
        vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 60, 90, 60), intArrayOf(0, 255, 0, 255), -1), attrs)
        speak(context.getString(R.string.a11y_key_now, keyName))
    }

    fun drift() {
        vibrator?.vibrate(VibrationEffect.createOneShot(400, 255), attrs)
    }

    /** "Key now A minor, 124 BPM" for a "What key is this?" request. */
    fun whatKey(keyName: String, bpm: Double) {
        speak(context.getString(R.string.a11y_key_now, context.getString(R.string.a11y_what_key, keyName, "%.0f".format(bpm))))
    }

    private fun speak(text: String) {
        val t = tts
        if (t == null) {
            pending = text
            tts = TextToSpeech(context.applicationContext) { status ->
                ready = status == TextToSpeech.SUCCESS
                if (ready) {
                    tts?.language = context.resources.configuration.locales[0] ?: Locale.getDefault()
                    pending?.let { tts?.speak(it, TextToSpeech.QUEUE_FLUSH, null, "key") }
                    pending = null
                }
            }
            return
        }
        if (ready) t.speak(text, TextToSpeech.QUEUE_FLUSH, null, "key") else pending = text
    }
}
