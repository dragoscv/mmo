package ro.mixai.app.ui.player

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Night mode / dialogue boost (D38) as a Media3 [AudioProcessor] on 16-bit PCM:
 * - 5.1 (6 channels, Media3 order FL FR FC LFE BL BR): centre (dialogue) +4 dB, LFE -6 dB, surrounds -3 dB;
 *   the platform downmix to stereo then carries clearer speech;
 * - stereo: mid/side, mid +3 dB, side -3 dB;
 * - then a feed-forward compressor (threshold -24 dBFS, ratio 3:1, 10 ms attack, 250 ms release, +6 dB make-up)
 *   that lifts quiet dialogue and tames explosions.
 * Toggled at runtime through [enabled] (pass-through when off, no reconfiguration needed).
 */
@UnstableApi
class DialogueBoostProcessor : BaseAudioProcessor() {
    @Volatile var enabled: Boolean = false

    private var env = 0.0
    private var attackCoef = 0.0
    private var releaseCoef = 0.0

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        // Anything else (float PCM, mono, 7.1) passes through untouched: an inactive processor, not an error.
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) return AudioProcessor.AudioFormat.NOT_SET
        if (inputAudioFormat.channelCount != 2 && inputAudioFormat.channelCount != 6) return AudioProcessor.AudioFormat.NOT_SET
        attackCoef = NightMath.coef(0.010, inputAudioFormat.sampleRate)
        releaseCoef = NightMath.coef(0.250, inputAudioFormat.sampleRate)
        return inputAudioFormat
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val remaining = inputBuffer.remaining()
        if (remaining == 0) return
        val out = replaceOutputBuffer(remaining)
        val channels = inputAudioFormat.channelCount
        if (!enabled) {
            out.put(inputBuffer)
            out.flip()
            return
        }
        val inS = inputBuffer.order(ByteOrder.nativeOrder())
        val frame = DoubleArray(channels)
        val frames = remaining / (2 * channels)
        repeat(frames) {
            for (c in 0 until channels) frame[c] = inS.short / 32768.0
            if (channels == 6) NightMath.boost51(frame) else NightMath.boostStereo(frame)
            var peak = 0.0
            for (c in 0 until channels) peak = max(peak, abs(frame[c]))
            env = NightMath.envelope(env, peak, attackCoef, releaseCoef)
            val g = NightMath.compressorGain(env)
            for (c in 0 until channels) out.putShort(NightMath.toPcm16(frame[c] * g))
        }
        // Odd trailing bytes (never expected for whole frames) are dropped.
        inS.position(inS.limit())
        out.flip()
    }

    override fun onFlush(streamMetadata: AudioProcessor.StreamMetadata) { env = 0.0 }
    override fun onReset() { env = 0.0 }
}

/** Renderers factory whose audio sink runs [DialogueBoostProcessor] (16-bit output so the processor sees PCM16). */
@UnstableApi
class BoostRenderersFactory(context: android.content.Context, private val boost: DialogueBoostProcessor) :
    androidx.media3.exoplayer.DefaultRenderersFactory(context) {
    override fun buildAudioSink(
        context: android.content.Context,
        enableFloatOutput: Boolean,
        enableAudioOutputPlaybackParams: Boolean,
    ): androidx.media3.exoplayer.audio.AudioSink =
        androidx.media3.exoplayer.audio.DefaultAudioSink.Builder(context)
            .setEnableFloatOutput(false)
            .setEnableAudioOutputPlaybackParameters(enableAudioOutputPlaybackParams)
            .setAudioProcessors(arrayOf(boost))
            .build()
}

/** Pure DSP math of the night mode (unit-tested). */
object NightMath {
    const val THRESHOLD_DB = -24.0
    const val RATIO = 3.0
    const val MAKEUP_DB = 6.0
    private const val CENTER_GAIN = 1.585 // +4 dB
    private const val LFE_GAIN = 0.501 // -6 dB
    private const val SURROUND_GAIN = 0.708 // -3 dB
    private const val MID_GAIN = 1.413 // +3 dB
    private const val SIDE_GAIN = 0.708 // -3 dB

    fun dbToLin(db: Double): Double = Math.pow(10.0, db / 20.0)
    fun linToDb(lin: Double): Double = if (lin <= 1e-9) -180.0 else 20.0 * kotlin.math.log10(lin)

    /** One-pole smoothing coefficient for a time constant in seconds. */
    fun coef(seconds: Double, sampleRate: Int): Double = exp(-1.0 / (seconds * sampleRate.coerceAtLeast(1)))

    fun envelope(prev: Double, peak: Double, attack: Double, release: Double): Double {
        val c = if (peak > prev) attack else release
        return c * prev + (1 - c) * peak
    }

    /** Linear gain for an envelope level: compression above the threshold, plus make-up gain. */
    fun compressorGain(envelope: Double): Double {
        val levelDb = linToDb(envelope)
        val over = levelDb - THRESHOLD_DB
        val reductionDb = if (over > 0) over - over / RATIO else 0.0
        return dbToLin(MAKEUP_DB - reductionDb)
    }

    fun boost51(f: DoubleArray) {
        f[2] *= CENTER_GAIN
        f[3] *= LFE_GAIN
        f[4] *= SURROUND_GAIN
        f[5] *= SURROUND_GAIN
    }

    fun boostStereo(f: DoubleArray) {
        val mid = (f[0] + f[1]) / 2 * MID_GAIN
        val side = (f[0] - f[1]) / 2 * SIDE_GAIN
        f[0] = mid + side
        f[1] = mid - side
    }

    /** Clamp to 16-bit PCM. */
    fun toPcm16(x: Double): Short = (x * 32767.0).roundToInt().coerceIn(-32768, 32767).toShort()
}
