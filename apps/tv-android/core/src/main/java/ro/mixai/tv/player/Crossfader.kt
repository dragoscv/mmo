package ro.mixai.tv.player

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
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

    private val tick = object : Runnable {
        override fun run() {
            step()
            handler.postDelayed(this, if (phase == Phase.FADING) RAMP_MS else POLL_MS)
        }
    }

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
        val nextDur = TrackItems.fromItem(nextItem)?.durationSec?.let { (it * 1000).toLong() }
        val fade = AudioPlan.fadeMs(p.crossfadeMs, dur, nextDur, TrackItems.fromItem(cur), TrackItems.fromItem(nextItem))
        if (fade <= 0) { if (phase == Phase.PRELOAD) cancel(); return }
        val remaining = dur - main.currentPosition
        if (phase == Phase.PRELOAD && (next != nextIndex || nextItem.mediaId != expectedItem?.mediaId)) cancel()
        if (phase == Phase.IDLE && remaining <= fade + PRELOAD_MS && remaining > fade / 2) preload(next, nextItem, fade)
        if (phase == Phase.PRELOAD && remaining <= fade) beginFade(remaining)
    }

    private fun preload(index: Int, item: MediaItem, fade: Long) {
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
        h.playWhenReady = false
        h.prepare()
        helper = h
        helperGain = gain
        nextIndex = index
        expectedItem = item
        fadeMs = fade
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
        main.seekTo(h.currentPosition + HANDOFF_LEAD_MS)
    }

    private fun finishHandoff() {
        Log.d(TAG, "handoff done at ${main.currentPosition}ms (helper ${helper?.currentPosition}ms)")
        main.volume = 1f
        releaseHelper()
        phase = Phase.IDLE
    }

    fun cancel() {
        if (phase == Phase.IDLE && helper == null) return
        Log.d(TAG, "cancel in $phase")
        releaseHelper()
        main.volume = 1f
        phase = Phase.IDLE
    }

    private fun releaseHelper() {
        helper?.run { stop(); release() }
        helper = null
        helperGain = null
        nextIndex = C.INDEX_UNSET
        expectedItem = null
    }

    // ─── main player events ───────────────────────────────────────────────

    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        when {
            phase == Phase.FADING && reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && mediaItem?.mediaId == expectedItem?.mediaId -> handoff()
            phase != Phase.IDLE -> cancel()
        }
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        if (!playWhenReady && phase != Phase.IDLE) cancel()
    }

    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
        // Our own handoff seek is expected; a user seek during preload/fade aborts the overlap.
        if (reason != Player.DISCONTINUITY_REASON_SEEK) return
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
    }
}
