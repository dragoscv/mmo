package ro.mixai.tv.data

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import ro.mixai.tv.data.generated.MusicQueueInput
import ro.mixai.tv.data.generated.TrackCard
import ro.mixai.tv.data.generated.TrackPlayInput
import ro.mixai.tv.player.MusicService
import ro.mixai.tv.player.TrackItems
import kotlin.coroutines.resume

/** off | all | one (server `MusicQueue.repeat`). */
enum class RepeatMode(val key: String) {
    Off("off"), All("all"), One("one");

    val playerMode: Int get() = when (this) { Off -> Player.REPEAT_MODE_OFF; All -> Player.REPEAT_MODE_ALL; One -> Player.REPEAT_MODE_ONE }

    companion object { fun of(key: String?): RepeatMode? = entries.firstOrNull { it.key == key } }
}

/** Snapshot of background music playback. */
data class MusicState(
    val queue: List<TrackCard> = emptyList(),
    val index: Int = -1,
    val playing: Boolean = false,
    val positionMs: Long = 0L,
    val durationMs: Long = 0L,
    val track: TrackCard? = null,
    val shuffle: Boolean = false,
    val repeat: RepeatMode = RepeatMode.Off,
    val buffering: Boolean = false,
    /** Volume 0..max of a remote output (Cast, DLNA, ...); null while playing on this device. */
    val remoteVolume: Int? = null,
    val remoteVolumeMax: Int = 100,
) {
    val isActive: Boolean get() = track != null
}

// App-side handle on [MusicService] through a Media3 MediaController. Exposes [state] (polled
// position 2×/s while playing), mirrors the queue to the server (`PUT /media/music/queue`,
// debounced 1.5 s) and records a play (`POST /media/plays`, trackKey `tr_<id>`) once a track
// passes 50 % or 4 minutes. Must be created/used on the main thread.
class MusicPlayback(
    private val context: Context,
    private val music: MusicRepository,
    private val media: MediaRepository,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var controller: MediaController? = null
    private var connecting: Job? = null
    private var queue: List<TrackCard> = emptyList()
    private var saveJob: Job? = null
    private var tickJob: Job? = null
    private var playedKey: String? = null

    private val _state = MutableStateFlow(MusicState())
    val state: StateFlow<MusicState> = _state.asStateFlow()

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) { publish(player) }
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) { playedKey = null; scheduleSave() }
        override fun onIsPlayingChanged(isPlaying: Boolean) { if (isPlaying) startTicker() }
    }

    private suspend fun ensureController(): MediaController {
        controller?.let { return it }
        val token = SessionToken(context, ComponentName(context, MusicService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        val c = suspendCancellableCoroutine<MediaController?> { cont ->
            future.addListener({ cont.resume(runCatching { future.get() }.getOrNull()) }, ContextCompat.getMainExecutor(context))
            cont.invokeOnCancellation { future.cancel(true) }
        } ?: error("music service unavailable")
        c.addListener(listener)
        controller = c
        return c
    }

    /** Connects early (optional) so the mini-player shows a running session after process restart. */
    fun connect() {
        if (controller != null || connecting?.isActive == true) return
        connecting = scope.launch { runCatching { ensureController() }.onFailure { Log.w(TAG, "connect: ${it.message}") } }
    }

    /** Replace the queue with [tracks] and start at [start]. */
    fun play(tracks: List<TrackCard>, start: Int = 0, startPositionMs: Long = 0L, shuffle: Boolean? = null, repeat: RepeatMode? = null) {
        if (tracks.isEmpty()) return
        queue = tracks
        scope.launch {
            val c = runCatching { ensureController() }.getOrElse { Log.w(TAG, "play: ${it.message}"); return@launch }
            shuffle?.let { c.shuffleModeEnabled = it }
            repeat?.let { c.repeatMode = it.playerMode }
            c.setMediaItems(tracks.map(::toItem), start.coerceIn(0, tracks.lastIndex), startPositionMs)
            c.prepare()
            c.play()
            playedKey = null
            scheduleSave()
        }
    }

    /**
     * Hub `play {trackIds,index,positionSec,shuffle,repeat}` from a phone (WP17-41h: a MixAI TV as a music output).
     * Returns the number of tracks started (0 = none found).
     */
    suspend fun playIds(ids: List<String>, index: Int, positionMs: Long, shuffle: Boolean?, repeat: RepeatMode?): Int {
        val want = ids.getOrNull(index)
        val tracks = music.tracksByIds(ids)
        if (tracks.isEmpty()) return 0
        val start = tracks.indexOfFirst { it.id == want }.takeIf { it >= 0 } ?: 0
        play(tracks, start, if (tracks.getOrNull(start)?.id == want) positionMs else 0L, shuffle, repeat)
        return tracks.size
    }

    /** Append to the queue (or start playing when idle). */
    fun enqueue(tracks: List<TrackCard>) {
        if (tracks.isEmpty()) return
        val c = controller
        if (c == null || queue.isEmpty()) { play(tracks); return }
        queue = queue + tracks
        c.addMediaItems(tracks.map(::toItem))
        scheduleSave()
    }

    /**
     * Voice / Assistant request: the service resolves [query] (blank = a mix) with [MusicResolver]
     * and the resulting queue is mirrored back into [state] by the player listener.
     */
    fun playFromSearch(query: String?, extras: android.os.Bundle? = null) {
        scope.launch {
            val c = runCatching { ensureController() }.getOrElse { Log.w(TAG, "search: ${it.message}"); return@launch }
            val request = MediaItem.RequestMetadata.Builder().setSearchQuery(query.orEmpty()).setExtras(extras).build()
            c.setMediaItems(listOf(MediaItem.Builder().setRequestMetadata(request).build()))
            c.prepare()
            c.play()
            playedKey = null
        }
    }

    fun toggle() { controller?.let { if (it.isPlaying) it.pause() else it.play() } }
    fun pause() { controller?.pause() }
    fun resume() { controller?.play() }
    fun next() { controller?.let { if (it.hasNextMediaItem()) it.seekToNextMediaItem() } }
    fun prev() { controller?.seekToPrevious() }
    fun seek(positionMs: Long) { controller?.seekTo(positionMs.coerceAtLeast(0)) }
    /** Remote output volume (no-op on this device: the system volume applies). */
    fun setRemoteVolume(level: Int) {
        controller?.let { if (it.isCommandAvailable(Player.COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS)) it.setDeviceVolume(level, 0) }
    }
    fun skipTo(index: Int) { controller?.let { if (index in 0 until it.mediaItemCount) it.seekToDefaultPosition(index) } }
    fun stop() { controller?.let { it.stop(); it.clearMediaItems() }; queue = emptyList(); _state.value = MusicState() }

    fun setShuffle(on: Boolean) { controller?.shuffleModeEnabled = on; scheduleSave() }
    fun setRepeat(mode: RepeatMode) {
        controller?.repeatMode = when (mode) { RepeatMode.Off -> Player.REPEAT_MODE_OFF; RepeatMode.All -> Player.REPEAT_MODE_ALL; RepeatMode.One -> Player.REPEAT_MODE_ONE }
        scheduleSave()
    }

    /**
     * Music state for the hub (`state` with media.trackId), null when idle. Emits on track / play-state changes
     * and every 5 s while playing (others extrapolate in between).
     */
    val hubNowPlaying: kotlinx.coroutines.flow.Flow<NowPlaying?> = state
        .map { s ->
            val t = s.track ?: return@map null
            HubSnapshot(t.id, s.playing, s.positionMs / 5_000, NowPlaying(
                playing = s.playing,
                positionSec = s.positionMs / 1000.0,
                durationSec = (s.durationMs / 1000.0).takeIf { it > 0 },
                media = ro.mixai.tv.data.generated.HubMedia(
                    kind = "track", trackId = t.id, title = t.title, artist = t.artist, album = t.album,
                    coverUrlPath = t.coverUrlPath.takeIf { it.isNotBlank() }, durationSec = t.durationSec.takeIf { it > 0 },
                ),
            ))
        }
        .distinctUntilChanged { a, b -> a?.key == b?.key }
        .map { it?.np }

    private data class HubSnapshot(val id: String, val playing: Boolean, val bucket: Long, val np: NowPlaying) {
        val key get() = Triple(id, playing, bucket)
    }

    /** Restore the server queue (paused) when nothing is playing. */
    fun restoreFromServer(lookup: suspend (List<String>) -> List<TrackCard>) {
        scope.launch {
            if (queue.isNotEmpty()) return@launch
            val q = runCatching { music.queue() }.getOrNull() ?: return@launch
            if (q.trackIds.isEmpty()) return@launch
            val tracks = runCatching { lookup(q.trackIds) }.getOrNull().orEmpty()
            if (tracks.isEmpty()) return@launch
            queue = tracks
            val c = runCatching { ensureController() }.getOrNull() ?: return@launch
            if (c.mediaItemCount > 0) return@launch
            c.setMediaItems(tracks.map(::toItem), q.index.toInt().coerceIn(0, tracks.lastIndex), (q.positionSec * 1000).toLong())
            c.shuffleModeEnabled = q.shuffle
            setRepeat(RepeatMode.entries.firstOrNull { it.key == q.repeat } ?: RepeatMode.Off)
            c.prepare()
        }
    }

    fun release() {
        controller?.removeListener(listener)
        controller?.release()
        controller = null
    }

    // ─── internals ────────────────────────────────────────────────────────

    private fun toItem(t: TrackCard): MediaItem = TrackItems.toItem(t, music.streamUrl(t), music.coverUrl(t)?.let(Uri::parse))

    /** Another controller (Android Auto, Assistant, the notification) replaced the queue → mirror the player. */
    private fun syncQueueFrom(p: Player) {
        val n = p.mediaItemCount
        if (n == queue.size && (0 until n).all { p.getMediaItemAt(it).mediaId == queue[it].id }) return
        queue = (0 until n).mapNotNull { TrackItems.fromItem(p.getMediaItemAt(it)) }
    }

    private fun publish(p: Player) {
        syncQueueFrom(p)
        val idx = p.currentMediaItemIndex
        val id = p.currentMediaItem?.mediaId
        val track = queue.getOrNull(idx)?.takeIf { it.id == id } ?: queue.firstOrNull { it.id == id }
        _state.value = MusicState(
            queue = queue,
            index = if (p.mediaItemCount == 0) -1 else idx,
            playing = p.isPlaying,
            positionMs = p.currentPosition.coerceAtLeast(0),
            durationMs = p.duration.takeIf { it > 0 } ?: ((track?.durationSec ?: 0.0) * 1000).toLong(),
            track = track,
            shuffle = p.shuffleModeEnabled,
            repeat = when (p.repeatMode) { Player.REPEAT_MODE_ALL -> RepeatMode.All; Player.REPEAT_MODE_ONE -> RepeatMode.One; else -> RepeatMode.Off },
            buffering = p.playbackState == Player.STATE_BUFFERING,
            remoteVolume = if (p.deviceInfo.playbackType == androidx.media3.common.DeviceInfo.PLAYBACK_TYPE_REMOTE &&
                p.isCommandAvailable(Player.COMMAND_GET_DEVICE_VOLUME)) p.deviceVolume else null,
            remoteVolumeMax = p.deviceInfo.maxVolume.takeIf { it > 0 } ?: 100,
        )
        maybePostPlay()
    }

    private fun startTicker() {
        if (tickJob?.isActive == true) return
        tickJob = scope.launch {
            while (true) {
                val c = controller ?: break
                publish(c)
                if (!c.isPlaying) break
                delay(500)
            }
        }
    }

    private fun maybePostPlay() {
        val s = _state.value
        val t = s.track ?: return
        if (playedKey == t.id) return
        val half = s.durationMs > 0 && s.positionMs >= s.durationMs / 2
        if (!(half || s.positionMs >= 240_000L)) return
        playedKey = t.id
        scope.launch(Dispatchers.IO) {
            runCatching {
                media.postPlay(TrackPlayInput(trackKey = "tr_${t.id}", durationSec = s.durationMs / 1000.0, completed = false, playedAt = System.currentTimeMillis()))
            }.onFailure { Log.w(TAG, "postPlay: ${it.message}") }
        }
    }

    private fun scheduleSave() {
        saveJob?.cancel()
        saveJob = scope.launch {
            delay(1_500)
            val s = _state.value
            val input = MusicQueueInput(
                trackIds = queue.take(2000).map { it.id },
                index = s.index.coerceAtLeast(0).toLong(),
                positionSec = s.positionMs / 1000.0,
                shuffle = s.shuffle,
                repeat = s.repeat.key,
            )
            launch(Dispatchers.IO) { runCatching { music.putQueue(input) }.onFailure { Log.w(TAG, "putQueue: ${it.message}") } }
        }
    }

    private companion object { const val TAG = "MusicPlayback" }
}
