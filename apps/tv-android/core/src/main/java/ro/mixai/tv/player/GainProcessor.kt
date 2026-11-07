package ro.mixai.tv.player

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Timeline
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.AudioProcessor.StreamMetadata
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer

/**
 * Linear gain on 16-bit / float PCM (loudness normalisation can boost, which player volume cannot).
 * A change of [target] ramps across one buffer, so it never clicks. Other encodings pass through.
 * When the sink announces a new stream, [gainFor] maps its media item to the gain, so the change
 * lands on the first sample of the next track; the service also sets [target] on item transitions.
 */
@UnstableApi
class GainProcessor(private val gainFor: (MediaItem) -> Float = { 1f }) : BaseAudioProcessor() {
    @Volatile var target: Float = 1f
    private var current = 1f
    private val period = Timeline.Period()
    private val window = Timeline.Window()

    override fun onConfigure(inputAudioFormat: AudioFormat): AudioFormat =
        if (inputAudioFormat.encoding == C.ENCODING_PCM_16BIT || inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT) inputAudioFormat else AudioFormat.NOT_SET

    override fun queueInput(inputBuffer: ByteBuffer) {
        val bytes = inputBuffer.remaining()
        if (bytes == 0) return
        val out = replaceOutputBuffer(bytes)
        val to = target
        val from = current
        if (from == 1f && to == 1f) {
            out.put(inputBuffer)
        } else {
            val float = inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT
            val channels = maxOf(inputAudioFormat.channelCount, 1)
            val frames = bytes / inputAudioFormat.bytesPerFrame
            for (f in 0 until frames) {
                val g = if (from == to) to else from + (to - from) * (f + 1) / frames
                repeat(channels) {
                    if (float) {
                        out.putFloat((inputBuffer.float * g).coerceIn(-1f, 1f))
                    } else {
                        out.putShort((inputBuffer.short * g).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort())
                    }
                }
            }
            // Partial trailing frame (never expected) is copied unchanged.
            while (inputBuffer.hasRemaining()) out.put(inputBuffer.get())
            current = to
        }
        out.flip()
    }

    override fun onFlush(streamMetadata: StreamMetadata) {
        val tl = streamMetadata.timeline
        val uid = streamMetadata.periodUid
        if (uid != null && !tl.isEmpty) {
            runCatching {
                val w = tl.getPeriodByUid(uid, period).windowIndex
                target = gainFor(tl.getWindow(w, window).mediaItem)
            }
        }
        current = target
    }

    override fun onReset() { current = target }
}
