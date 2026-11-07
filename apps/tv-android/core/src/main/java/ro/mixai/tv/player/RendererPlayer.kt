package ro.mixai.tv.player

import android.os.Looper
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.DeviceInfo
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import ro.mixai.tv.cast.RemoteItem
import ro.mixai.tv.cast.RemoteState
import ro.mixai.tv.cast.RemoteStatus
import ro.mixai.tv.cast.RemoteTransport

/**
 * Media3 player over a [RemoteTransport] (WP17-41h): DLNA renderers, Home Assistant players, MixAI TVs. It is
 * swapped into the music MediaSession while a remote output is active, so the notification, lock screen,
 * Android Auto, the widget, the watch and the volume keys (remote [DeviceInfo]) all control the renderer.
 *
 * The queue lives here; the renderer gets one item at a time (plus the next one for gapless where supported),
 * except [RemoteTransport.ownsQueue] renderers, which get the whole queue and report the track they play.
 * State comes from polling the renderer once a second. After [LOST_AFTER] failed polls [onLost] fires with
 * the current position so the service can move playback back to this device.
 */
@UnstableApi
class RendererPlayer(
    private val transport: RemoteTransport,
    /** MediaItem → renderer item for the given sink mimes. */
    private val convert: (MediaItem, Set<String>) -> RemoteItem?,
    private val onLost: (RendererPlayer, String) -> Unit,
) : SimpleBasePlayer(Looper.getMainLooper()) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val io = Mutex()
    private var poller: Job? = null

    private val items = ArrayList<MediaItem>()
    private val uids = ArrayList<Any>()
    private var index = 0
    private var playWhenReady = false
    private var playbackState = Player.STATE_IDLE
    private var positionMs = 0L
    private var positionAt = 0L
    private var durationMs = C.TIME_UNSET
    private var repeat = Player.REPEAT_MODE_OFF
    private var shuffle = false
    private var volume = 50
    private var muted = false
    private var error: PlaybackException? = null
    private var sink: Set<String> = emptySet()

    // Track-end detection for renderers that play one item at a time.
    private var loadedUrl: String? = null
    private var nextUrl: String? = null
    private var seenPlaying = false
    private var failures = 0
    private var released = false
    private var lastLogged: RemoteState? = null
    private var errorPolls = 0
    private var loadedAt = 0L

    private val remoteDevice = DeviceInfo.Builder(DeviceInfo.PLAYBACK_TYPE_REMOTE).setMinVolume(0).setMaxVolume(100).build()

    val currentPositionForHandoff: Long get() = livePosition()

    /** Connects to the renderer, then starts [queue] at [startIndex]/[startPositionMs]. */
    fun start(queue: List<MediaItem>, startIndex: Int, startPositionMs: Long, play: Boolean, repeatMode: Int, shuffleOn: Boolean) {
        items.clear(); uids.clear()
        queue.forEach { items.add(it); uids.add(Any()) }
        index = startIndex.coerceIn(0, maxOf(0, items.lastIndex))
        positionMs = startPositionMs.coerceAtLeast(0)
        positionAt = now()
        playWhenReady = play
        repeat = repeatMode
        shuffle = shuffleOn
        playbackState = if (items.isEmpty()) Player.STATE_IDLE else Player.STATE_BUFFERING
        invalidateState()
        scope.launch {
            try {
                sink = io.withLock { transport.prepare() }
                if (items.isNotEmpty()) loadCurrent(positionMs, play)
                if (transport.supportsVolume) runCatching { io.withLock { transport.status() } }.getOrNull()?.let { s ->
                    s.volume?.let { volume = it }; s.muted?.let { muted = it }; invalidateState()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "start ${transport.target.id}: ${e.message}")
                lose(e.message ?: "unreachable")
                return@launch
            }
            startPolling()
        }
    }

    // ─── state ────────────────────────────────────────────────────────────

    override fun getState(): State {
        val commands = Player.Commands.Builder()
            .addAll(
                Player.COMMAND_PLAY_PAUSE, Player.COMMAND_PREPARE, Player.COMMAND_STOP,
                Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
                Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_NEXT,
                Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                Player.COMMAND_SEEK_TO_MEDIA_ITEM, Player.COMMAND_SET_MEDIA_ITEM, Player.COMMAND_CHANGE_MEDIA_ITEMS,
                Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_METADATA,
                Player.COMMAND_SET_REPEAT_MODE, Player.COMMAND_SET_SHUFFLE_MODE, Player.COMMAND_RELEASE,
                Player.COMMAND_GET_AUDIO_ATTRIBUTES,
            )
            .addIf(Player.COMMAND_GET_DEVICE_VOLUME, transport.supportsVolume)
            .addIf(Player.COMMAND_SET_DEVICE_VOLUME_WITH_FLAGS, transport.supportsVolume)
            .addIf(Player.COMMAND_ADJUST_DEVICE_VOLUME_WITH_FLAGS, transport.supportsVolume)
            .build()
        val playlist = items.mapIndexed { i, item ->
            val dur = if (i == index && durationMs != C.TIME_UNSET) durationMs else item.mediaMetadata.durationMs ?: C.TIME_UNSET
            MediaItemData.Builder(uids[i])
                .setMediaItem(item)
                .setMediaMetadata(item.mediaMetadata)
                .setDurationUs(if (dur == C.TIME_UNSET) C.TIME_UNSET else dur * 1000)
                .setIsSeekable(true)
                .build()
        }
        val pos = livePosition()
        val playing = playWhenReady && playbackState == Player.STATE_READY
        return State.Builder()
            .setAvailableCommands(commands)
            .setPlaylist(playlist)
            .setCurrentMediaItemIndex(if (items.isEmpty()) C.INDEX_UNSET else index)
            .setPlayWhenReady(playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setPlaybackState(if (items.isEmpty()) Player.STATE_IDLE else playbackState)
            .setContentPositionMs(if (playing) PositionSupplier.getExtrapolating(pos, 1f) else PositionSupplier.getConstant(pos))
            .setRepeatMode(repeat)
            .setShuffleModeEnabled(shuffle)
            .setDeviceInfo(remoteDevice)
            .setDeviceVolume(volume)
            .setIsDeviceMuted(muted)
            .setPlayerError(error)
            .build()
    }

    private fun livePosition(): Long {
        val playing = playWhenReady && playbackState == Player.STATE_READY
        val base = if (playing) positionMs + (now() - positionAt) else positionMs
        return if (durationMs > 0) base.coerceIn(0, durationMs) else base.coerceAtLeast(0)
    }

    private fun now() = android.os.SystemClock.elapsedRealtime()

    // ─── handlers ─────────────────────────────────────────────────────────

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        positionMs = livePosition(); positionAt = now()
        this.playWhenReady = playWhenReady
        if (playbackState == Player.STATE_ENDED && playWhenReady) {
            index = 0; positionMs = 0
            launchIo { loadCurrent(0, true) }
        } else launchIo { if (playWhenReady) transport.play() else transport.pause() }
        return done()
    }

    override fun handlePrepare(): ListenableFuture<*> {
        if (items.isNotEmpty() && playbackState == Player.STATE_IDLE) {
            playbackState = Player.STATE_BUFFERING
            error = null
            launchIo { loadCurrent(positionMs, playWhenReady) }
        }
        return done()
    }

    override fun handleStop(): ListenableFuture<*> {
        positionMs = livePosition(); positionAt = now()
        playbackState = Player.STATE_IDLE
        loadedUrl = null; seenPlaying = false
        launchIo { transport.stop() }
        return done()
    }

    override fun handleRelease(): ListenableFuture<*> {
        released = true
        poller?.cancel()
        scope.cancel()
        transport.release()
        return done()
    }

    override fun handleSetRepeatMode(repeatMode: Int): ListenableFuture<*> {
        repeat = repeatMode
        refreshNext()
        return done()
    }

    override fun handleSetShuffleModeEnabled(shuffleModeEnabled: Boolean): ListenableFuture<*> {
        shuffle = shuffleModeEnabled
        refreshNext()
        return done()
    }

    override fun handleSetMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<*> {
        items.clear(); uids.clear()
        mediaItems.forEach { items.add(it); uids.add(Any()) }
        index = if (startIndex == C.INDEX_UNSET) 0 else startIndex.coerceIn(0, maxOf(0, items.lastIndex))
        positionMs = if (startPositionMs == C.TIME_UNSET) 0 else startPositionMs
        positionAt = now()
        durationMs = C.TIME_UNSET
        if (items.isEmpty()) {
            playbackState = Player.STATE_IDLE
            launchIo { transport.stop() }
        } else if (playbackState != Player.STATE_IDLE) {
            playbackState = Player.STATE_BUFFERING
            launchIo { loadCurrent(positionMs, playWhenReady) }
        }
        return done()
    }

    override fun handleAddMediaItems(index: Int, mediaItems: MutableList<MediaItem>): ListenableFuture<*> {
        val at = index.coerceIn(0, items.size)
        items.addAll(at, mediaItems)
        uids.addAll(at, mediaItems.map { Any() })
        if (items.size == mediaItems.size) this.index = 0 else if (at <= this.index) this.index += mediaItems.size
        queueChanged()
        return done()
    }

    override fun handleRemoveMediaItems(fromIndex: Int, toIndex: Int): ListenableFuture<*> {
        val from = fromIndex.coerceIn(0, items.size)
        val to = toIndex.coerceIn(from, items.size)
        val removedCurrent = index in from until to
        repeat(to - from) { items.removeAt(from); uids.removeAt(from) }
        when {
            items.isEmpty() -> { index = 0; playbackState = Player.STATE_IDLE; launchIo { transport.stop() } }
            removedCurrent -> {
                index = from.coerceAtMost(items.lastIndex)
                positionMs = 0; positionAt = now()
                if (playbackState != Player.STATE_IDLE) launchIo { loadCurrent(0, playWhenReady) }
            }
            index >= to -> index -= (to - from)
        }
        queueChanged()
        return done()
    }

    override fun handleMoveMediaItems(fromIndex: Int, toIndex: Int, newIndex: Int): ListenableFuture<*> {
        val moved = ArrayList(items.subList(fromIndex, toIndex))
        val movedUids = ArrayList(uids.subList(fromIndex, toIndex))
        val currentUid = uids.getOrNull(index)
        repeat(toIndex - fromIndex) { items.removeAt(fromIndex); uids.removeAt(fromIndex) }
        val at = newIndex.coerceIn(0, items.size)
        items.addAll(at, moved); uids.addAll(at, movedUids)
        currentUid?.let { u -> index = uids.indexOf(u).coerceAtLeast(0) }
        queueChanged()
        return done()
    }

    override fun handleReplaceMediaItems(fromIndex: Int, toIndex: Int, mediaItems: MutableList<MediaItem>): ListenableFuture<*> {
        val from = fromIndex.coerceIn(0, items.size)
        val to = toIndex.coerceIn(from, items.size)
        val currentReplaced = index in from until to
        val currentUid = uids.getOrNull(index)
        repeat(to - from) { items.removeAt(from); uids.removeAt(from) }
        items.addAll(from, mediaItems); uids.addAll(from, mediaItems.map { Any() })
        if (currentReplaced) {
            index = (from + (index - from)).coerceIn(0, maxOf(0, items.lastIndex))
            uids[index] = currentUid ?: uids[index]
        } else if (index >= to) index += mediaItems.size - (to - from)
        queueChanged()
        return done()
    }

    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        if (items.isEmpty()) return done()
        val target = if (mediaItemIndex == C.INDEX_UNSET) index else mediaItemIndex.coerceIn(0, items.lastIndex)
        val pos = if (positionMs == C.TIME_UNSET) 0 else positionMs.coerceAtLeast(0)
        this.positionMs = pos; positionAt = now()
        if (target != index || playbackState == Player.STATE_ENDED || playbackState == Player.STATE_IDLE) {
            index = target
            durationMs = C.TIME_UNSET
            playbackState = Player.STATE_BUFFERING
            launchIo { loadCurrent(pos, playWhenReady) }
        } else {
            launchIo { transport.seek(pos) }
        }
        return done()
    }

    override fun handleSetDeviceVolume(deviceVolume: Int, flags: Int): ListenableFuture<*> {
        volume = deviceVolume.coerceIn(0, 100)
        launchIo { transport.setVolume(volume) }
        return done()
    }

    override fun handleIncreaseDeviceVolume(flags: Int): ListenableFuture<*> = handleSetDeviceVolume(volume + VOLUME_STEP, flags)
    override fun handleDecreaseDeviceVolume(flags: Int): ListenableFuture<*> = handleSetDeviceVolume(volume - VOLUME_STEP, flags)

    override fun handleSetDeviceMuted(muted: Boolean, flags: Int): ListenableFuture<*> {
        this.muted = muted
        launchIo { transport.setMuted(muted) }
        return done()
    }

    // ─── renderer I/O ─────────────────────────────────────────────────────

    private fun done(): ListenableFuture<*> = Futures.immediateVoidFuture()

    private fun launchIo(block: suspend () -> Unit) {
        if (released) return
        scope.launch {
            try { io.withLock { block() } } catch (e: CancellationException) { throw e } catch (e: Exception) {
                Log.w(TAG, "${transport.target.id}: ${e.message}")
            }
        }
    }

    private fun queueChanged() {
        if (transport.ownsQueue && playbackState != Player.STATE_IDLE && items.isNotEmpty()) {
            positionMs = livePosition(); positionAt = now()
            launchIo { loadCurrent(positionMs, playWhenReady) }
        } else refreshNext()
    }

    /** Must run under [io] (or before polling starts). */
    private suspend fun loadCurrent(startMs: Long, play: Boolean) {
        val item = items.getOrNull(index) ?: return
        seenPlaying = false
        nextUrl = null
        if (transport.ownsQueue) {
            val queue = items.mapNotNull { convert(it, sink) }
            transport.load(queue, index.coerceIn(0, maxOf(0, queue.lastIndex)), startMs, play, repeat)
            loadedUrl = queue.getOrNull(index)?.url
        } else {
            val r = convert(item, sink) ?: throw IllegalStateException("track cannot play here")
            Log.i(TAG, "${transport.target.id} load ${r.trackId} mime=${r.mime} at=$startMs sink=${sink.size}")
            transport.load(listOf(r), 0, startMs, play, repeat)
            loadedUrl = r.url
            loadedAt = now()
            durationMs = r.durationMs ?: C.TIME_UNSET
            pushNext()
        }
        invalidateOnMain()
    }

    private fun nextIndex(): Int? {
        if (items.isEmpty()) return null
        if (repeat == Player.REPEAT_MODE_ONE) return index
        val n = index + 1
        return if (n <= items.lastIndex) n else if (repeat == Player.REPEAT_MODE_ALL) 0 else null
    }

    private fun refreshNext() {
        if (!transport.supportsNext || transport.ownsQueue || loadedUrl == null) return
        launchIo { pushNext() }
    }

    private suspend fun pushNext() {
        if (!transport.supportsNext) return
        val n = nextIndex()?.takeIf { it != index } ?: run { if (nextUrl != null) { transport.setNext(null); nextUrl = null }; return }
        val r = convert(items[n], sink) ?: return
        if (r.url == nextUrl) return
        nextUrl = if (transport.setNext(r)) r.url else null
    }

    private fun startPolling() {
        poller?.cancel()
        poller = scope.launch {
            while (true) {
                delay(POLL_MS)
                val s = try {
                    io.withLock { transport.status() }
                } catch (e: CancellationException) { throw e } catch (e: Exception) {
                    if (++failures >= LOST_AFTER) { lose(e.message ?: "lost"); return@launch }
                    continue
                }
                failures = 0
                applyStatus(s)
            }
        }
    }

    private suspend fun applyStatus(s: RemoteStatus) {
        if (s.state != lastLogged) { Log.i(TAG, "${transport.target.id} state=${s.state} pos=${s.positionMs} dur=${s.durationMs} err=${s.error}"); lastLogged = s.state }
        s.volume?.let { volume = it }
        s.muted?.let { muted = it }
        if (transport.ownsQueue) applyQueueOwner(s) else applySingle(s)
        invalidateState()
    }

    private fun applyQueueOwner(s: RemoteStatus) {
        s.trackId?.let { id ->
            val i = items.indexOfFirst { it.mediaId == id }
            if (i >= 0 && i != index) { index = i; durationMs = C.TIME_UNSET }
        }
        s.durationMs?.let { durationMs = it }
        s.positionMs?.let { positionMs = it; positionAt = now() }
        when (s.state) {
            RemoteState.PLAYING -> { seenPlaying = true; playbackState = Player.STATE_READY; playWhenReady = true }
            RemoteState.PAUSED -> { playbackState = Player.STATE_READY; playWhenReady = false }
            RemoteState.BUFFERING -> playbackState = Player.STATE_BUFFERING
            RemoteState.STOPPED -> if (seenPlaying) { playbackState = Player.STATE_ENDED; seenPlaying = false }
        }
    }

    private suspend fun applySingle(s: RemoteStatus) {
        // The renderer could not open the stream (format, HTTPS it does not trust, unreachable host): fail over
        // to this device instead of sitting in "buffering". A renderer may keep the old error status while the
        // next URI loads, so only count it once the current URI is the one we set.
        if (s.error != null && (s.uri == null || s.uri == loadedUrl || loadedUrl?.let { s.uri.contains(it.substringBefore('?')) } == true)) {
            if (++errorPolls >= ERROR_POLLS) { lose("error"); return }
        } else errorPolls = 0
        // Some renderers stay TRANSITIONING forever on a stream they cannot open (HTTPS with an unknown CA).
        if (playWhenReady && !seenPlaying && s.state != RemoteState.PLAYING && loadedAt > 0 && now() - loadedAt > START_TIMEOUT_MS) {
            lose("timeout"); return
        }
        // Gapless: the renderer moved to the URI we queued with SetNextAVTransportURI.
        val next = nextUrl
        if (next != null && s.uri != null && s.uri == next && s.uri != loadedUrl) {
            nextIndex()?.let { index = it }
            loadedUrl = next; nextUrl = null; durationMs = C.TIME_UNSET
            io.withLock { pushNext() }
        }
        s.durationMs?.takeIf { it > 0 }?.let { durationMs = it }
        s.positionMs?.let { positionMs = it; positionAt = now() }
        when (s.state) {
            RemoteState.PLAYING -> { seenPlaying = true; playbackState = Player.STATE_READY }
            RemoteState.PAUSED -> if (playbackState != Player.STATE_IDLE) playbackState = Player.STATE_READY
            RemoteState.BUFFERING -> if (playbackState != Player.STATE_IDLE) playbackState = Player.STATE_BUFFERING
            RemoteState.STOPPED -> if (seenPlaying && playbackState != Player.STATE_IDLE && playWhenReady) trackEnded()
        }
    }

    private suspend fun trackEnded() {
        seenPlaying = false
        val n = nextIndex()
        if (n == null) {
            playbackState = Player.STATE_ENDED
            playWhenReady = false
            positionMs = durationMs.takeIf { it > 0 } ?: positionMs
            return
        }
        index = n; positionMs = 0; positionAt = now(); durationMs = C.TIME_UNSET
        playbackState = Player.STATE_BUFFERING
        invalidateState()
        try { io.withLock { loadCurrent(0, true) } } catch (e: CancellationException) { throw e } catch (e: Exception) {
            Log.w(TAG, "advance: ${e.message}")
        }
    }

    private fun invalidateOnMain() { if (!released) scope.launch { invalidateState() } }

    private fun lose(message: String) {
        if (released) return
        positionMs = livePosition(); positionAt = now()
        onLost(this, message)
    }

    companion object {
        private const val TAG = "RendererPlayer"
        private const val POLL_MS = 1_000L
        private const val LOST_AFTER = 6
        private const val ERROR_POLLS = 2
        private const val START_TIMEOUT_MS = 20_000L
        private const val VOLUME_STEP = 5
    }
}
