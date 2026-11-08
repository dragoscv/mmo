package ro.mixai.tv.player

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.source.MediaSource

/**
 * True-overlap crossfade (WP17-41e) around the session's single [main] player, which stays the only
 * player Android Auto, the notification and the app's controller see.
 *
 * Near the end of a track a muted helper ExoPlayer pre-buffers the next queue item; during the last
 * [AudioPlan.fadeMs] ms the helper fades in while [main] fades out (equal power). When [main] reaches
 * the next item on its own (gapless auto-transition) it is seeked to the helper's position, unmuted
 * once playing, and the helper stops. Any user action during the overlap (pause, seek, skip, queue
 * edit) cancels it and restores [main]. Album continuations and repeat-one stay plain gapless.
 *
 * Automix (WP17-44, [AudioPrefs.automix]): when both tracks have BPM the helper plays at the outgoing tempo (±6 %,
 * pitch kept), enters on its first downbeat, the fade starts on a downbeat of the outgoing track and lasts whole bars;
 * when the fade completes before the outgoing track ends, [main] is moved to the next item right away. After the
 * handoff [main] keeps the matched speed and glides back to 1 over [GLIDE_MS].
 */
@UnstableApi
class Crossfader(
    private val context: Context,
    private val main: ExoPlayer,
    private val mediaSourceFactory: MediaSource.Factory,
    private val prefs: () -> AudioPrefs,
    private val gainFor: (MediaItem) -> Float,
) : Player.Listener {
    private enum class Phase { IDLE, PRELOAD, FADING, HANDOFF }

    private val handler = Handler(Looper.getMainLooper())
    private var helper: ExoPlayer? = null
    private var helperGain: GainProcessor? = null
    private var phase = Phase.IDLE
    private var fadeMs = 0L
    private var fadeStartedAt = 0L
    private var handoffAt = 0L
    private var handoffSeeked = false
    private var nextIndex = C.INDEX_UNSET
    private var expectedItem: MediaItem? = null
    private var plan: MixPlan? = null
    private var fadeAtMs = 0L
    private var earlyHandoff = false
    private var glideFrom = 1f
    private var glideStartedAt = 0L
    private var gliding = false

    private val tick = object : Runnable {
        override fun run() {
            step()
            handler.postDelayed(this, if (phase == Phase.FADING || gliding || nearFade()) RAMP_MS else POLL_MS)
        }
    }

    /** Poll fast in the last second before a planned fade so a downbeat-aligned start is not late by up to 250 ms. */
    private fun nearFade(): Boolean = phase == Phase.PRELOAD && main.currentPosition >= fadeAtMs - 1_000

    fun start() {
        main.addListener(this)
        handler.post(tick)
    }

    fun release() {
        handler.removeCallbacks(tick)
        main.removeListener(this)
        cancel()
    }

    private fun step() {
        if (gliding) glide()
        when (phase) {
            Phase.IDLE, Phase.PRELOAD -> maybeSchedule()
            Phase.FADING -> ramp()
            Phase.HANDOFF -> if (handoffSeeked && main.playbackState == Player.STATE_READY && main.isPlaying) finishHandoff()
                else if (System.currentTimeMillis() - handoffAt > HANDOFF_TIMEOUT_MS) cancel()
        }
    }

    private fun maybeSchedule() {
        val p = prefs()
        if (p.crossfadeMs <= 0 || !main.isPlaying || main.repeatMode == Player.REPEAT_MODE_ONE) {
            if (phase == Phase.PRELOAD) cancel()
            return
        }
        val dur = main.duration
        val next = main.nextMediaItemIndex
        if (dur == C.TIME_UNSET || dur <= 0 || next == C.INDEX_UNSET) { if (phase == Phase.PRELOAD) cancel(); return }
        val cur = main.currentMediaItem ?: return
        val nextItem = main.getMediaItemAt(next)
        val curCard = TrackItems.fromItem(cur)
        val nextCard = TrackItems.fromItem(nextItem)
        val nextDur = nextCard?.durationSec?.let { (it * 1000).toLong() }
        val baseFade = AudioPlan.fadeMs(p.crossfadeMs, dur, nextDur, curCard, nextCard)
        val mix = AudioPlan.mixPlan(p, baseFade, curCard, nextCard)
        val fade = mix.fadeMs
        if (fade <= 0) { if (phase == Phase.PRELOAD) cancel(); return }
        val startAt = if (mix.beatMatched) AudioPlan.fadeStartMs(dur, curCard, fade) else dur - fade
        val untilFade = startAt - main.currentPosition
        if (phase == Phase.PRELOAD && (next != nextIndex || nextItem.mediaId != expectedItem?.mediaId)) cancel()
        if (phase == Phase.IDLE && untilFade <= PRELOAD_MS && untilFade > -fade / 2) preload(next, nextItem, mix, startAt)
        if (phase == Phase.PRELOAD && untilFade <= 0) beginFade(minOf(fade, dur - main.currentPosition))
    }

    private fun preload(index: Int, item: MediaItem, mix: MixPlan, startAt: Long) {
        val gain = GainProcessor(gainFor).apply { target = gainFor(item) }
        val renderers = object : DefaultRenderersFactory(context) {
            override fun buildAudioSink(ctx: Context, enableFloatOutput: Boolean, enableAudioOutputPlaybackParameters: Boolean): AudioSink =
                DefaultAudioSink.Builder(ctx)
                    .setEnableFloatOutput(enableFloatOutput)
                    .setEnableAudioOutputPlaybackParameters(enableAudioOutputPlaybackParameters)
                    .setAudioProcessors(arrayOf(gain))
                    .build()
        }
        val h = ExoPlayer.Builder(context, renderers)
            .setMediaSourceFactory(mediaSourceFactory)
            // No audio focus: the session player owns it; the helper only overlaps for a few seconds.
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), false)
            .build()
        h.volume = 0f
        h.setMediaItem(item)
        if (mix.incomingStartMs > 0) h.seekTo(mix.incomingStartMs)
        if (mix.incomingRate != 1f) h.playbackParameters = PlaybackParameters(mix.incomingRate, 1f)
        h.playWhenReady = false
        h.prepare()
        helper = h
        helperGain = gain
        nextIndex = index
        expectedItem = item
        fadeMs = mix.fadeMs
        plan = mix
        fadeAtMs = startAt
        phase = Phase.PRELOAD
    }

    private fun beginFade(remaining: Long) {
        val h = helper ?: return cancel()
        if (h.playbackState != Player.STATE_READY) return // not buffered yet: try again next tick
        fadeMs = remaining.coerceAtLeast(1)
        fadeStartedAt = System.currentTimeMillis()
        h.play()
        phase = Phase.FADING
        Log.d(TAG, "crossfade ${fadeMs}ms → ${expectedItem?.mediaId}")
    }

    private fun ramp() {
        val h = helper ?: return cancel()
        val elapsed = System.currentTimeMillis() - fadeStartedAt
        // Automix: the fade ended before the outgoing track did → hand over now instead of waiting for the track end.
        if (elapsed >= fadeMs && plan?.beatMatched == true && !earlyHandoff) {
            earlyHandoff = true
            main.volume = 0f
            h.volume = 1f
            if (main.hasNextMediaItem()) main.seekToNextMediaItem() else cancel()
            return
        }
        // Main never transitioned (duration estimate was off, stalled stream): give up and restore it.
        if (elapsed > fadeMs + HANDOFF_TIMEOUT_MS) return cancel()
        val t = (elapsed.toFloat() / fadeMs).coerceIn(0f, 1f)
        main.volume = AudioPlan.fadeOut(t)
        h.volume = AudioPlan.fadeIn(t)
    }

    /** Main reached the next item by itself: jump it to where the helper is, unmute once it plays. */
    private fun handoff() {
        val h = helper ?: return cancel()
        phase = Phase.HANDOFF
        handoffAt = System.currentTimeMillis()
        handoffSeeked = false
        h.volume = 1f
        main.volume = 0f
        // Keep the matched tempo on the session player, then glide it back to native speed (pitch kept).
        val rate = plan?.incomingRate ?: 1f
        if (rate != 1f) main.playbackParameters = PlaybackParameters(rate, 1f)
        main.seekTo(h.currentPosition + HANDOFF_LEAD_MS)
    }

    private fun finishHandoff() {
        Log.d(TAG, "handoff done at ${main.currentPosition}ms (helper ${helper?.currentPosition}ms)")
        main.volume = 1f
        val rate = plan?.incomingRate ?: 1f
        if (rate != 1f) { glideFrom = rate; glideStartedAt = System.currentTimeMillis(); gliding = true }
        releaseHelper()
        phase = Phase.IDLE
    }

    private fun glide() {
        val r = AudioPlan.glideRate(glideFrom, System.currentTimeMillis() - glideStartedAt, GLIDE_MS)
        main.playbackParameters = PlaybackParameters(r, 1f)
        if (r == 1f) gliding = false
    }

    fun cancel() {
        if (phase == Phase.IDLE && helper == null) return
        Log.d(TAG, "cancel in $phase")
        releaseHelper()
        main.volume = 1f
        if (main.playbackParameters.speed != 1f) main.playbackParameters = PlaybackParameters.DEFAULT
        gliding = false
        phase = Phase.IDLE
    }

    private fun releaseHelper() {
        helper?.run { stop(); release() }
        helper = null
        helperGain = null
        nextIndex = C.INDEX_UNSET
        expectedItem = null
        plan = null
        earlyHandoff = false
    }

    // ─── main player events ───────────────────────────────────────────────

    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        when {
            phase == Phase.FADING && mediaItem?.mediaId == expectedItem?.mediaId &&
                (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO || (earlyHandoff && reason == Player.MEDIA_ITEM_TRANSITION_REASON_SEEK)) -> handoff()
            phase != Phase.IDLE -> cancel()
            gliding -> { gliding = false; main.playbackParameters = PlaybackParameters.DEFAULT }
        }
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        if (!playWhenReady && phase != Phase.IDLE) cancel()
    }

    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
        // Our own handoff seek is expected; a user seek during preload/fade aborts the overlap.
        if (reason != Player.DISCONTINUITY_REASON_SEEK) return
        if (phase == Phase.FADING && earlyHandoff) return // our own seekToNextMediaItem
        if (phase == Phase.HANDOFF) handoffSeeked = true
        else if (phase == Phase.PRELOAD || phase == Phase.FADING) cancel()
    }

    override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
        if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED && phase == Phase.PRELOAD) cancel()
    }

    override fun onPlayerError(error: androidx.media3.common.PlaybackException) { cancel() }

    private companion object {
        const val TAG = "Crossfader"
        const val POLL_MS = 250L
        const val RAMP_MS = 40L
        const val PRELOAD_MS = 8_000L
        const val HANDOFF_LEAD_MS = 120L
        const val HANDOFF_TIMEOUT_MS = 4_000L
        const val GLIDE_MS = 8_000L
    }
}
