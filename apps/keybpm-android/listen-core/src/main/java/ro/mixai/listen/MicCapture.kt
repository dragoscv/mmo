package ro.mixai.listen

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Process

/**
 * Microphone → float PCM blocks (D69): `UNPROCESSED` when the device supports it (no AGC / noise suppression,
 * which smear onsets and dynamics), otherwise `VOICE_RECOGNITION` (the least processed fallback). Mono, 48 kHz
 * (44.1 fallback), 20 ms blocks, on an URGENT_AUDIO thread. Nothing is stored: blocks go straight to [onBlock].
 */
class MicCapture(private val context: Context) {
    @Volatile private var running = false
    private var thread: Thread? = null

    var sampleRate: Int = 48_000
        private set

    fun preferredSource(): Int {
        val am = context.getSystemService(AudioManager::class.java)
        val unprocessed = am?.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true"
        return if (unprocessed) MediaRecorder.AudioSource.UNPROCESSED else MediaRecorder.AudioSource.VOICE_RECOGNITION
    }

    /** Caller must hold RECORD_AUDIO. Returns false when the recorder could not start. */
    @SuppressLint("MissingPermission")
    fun start(onBlock: (FloatArray) -> Unit): Boolean {
        if (running) return true
        val record = open() ?: return false
        running = true
        thread = Thread({
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
            val block = FloatArray(sampleRate / 50)
            try {
                record.startRecording()
                while (running) {
                    val n = record.read(block, 0, block.size, AudioRecord.READ_BLOCKING)
                    if (n > 0) onBlock(if (n == block.size) block.copyOf() else block.copyOf(n))
                    else if (n < 0) break
                }
            } finally {
                runCatching { record.stop() }
                record.release()
                running = false
            }
        }, "keybpm-mic").apply { start() }
        return true
    }

    fun stop() {
        running = false
        thread?.join(500)
        thread = null
    }

    @SuppressLint("MissingPermission")
    private fun open(): AudioRecord? {
        for (rate in intArrayOf(48_000, 44_100)) {
            val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT)
            if (min <= 0) continue
            for (source in intArrayOf(preferredSource(), MediaRecorder.AudioSource.MIC)) {
                val r = runCatching {
                    AudioRecord.Builder()
                        .setAudioSource(source)
                        .setAudioFormat(
                            AudioFormat.Builder()
                                .setSampleRate(rate)
                                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                                .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                                .build(),
                        )
                        .setBufferSizeInBytes(maxOf(min * 2, rate / 5 * 4))
                        .build()
                }.getOrNull()
                if (r != null && r.state == AudioRecord.STATE_INITIALIZED) {
                    sampleRate = rate
                    return r
                }
                r?.release()
            }
        }
        return null
    }
}
