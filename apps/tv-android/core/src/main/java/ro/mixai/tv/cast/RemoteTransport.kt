package ro.mixai.tv.cast

/** One queue entry as a renderer sees it (stream URL already in a format the renderer accepts). */
data class RemoteItem(
    val trackId: String,
    val url: String,
    val mime: String,
    val title: String,
    val artist: String?,
    val album: String?,
    val artUrl: String?,
    val durationMs: Long?,
)

enum class RemoteState { PLAYING, PAUSED, BUFFERING, STOPPED }

/** One poll of the renderer. Null fields = not reported. */
data class RemoteStatus(
    val state: RemoteState,
    val positionMs: Long? = null,
    val durationMs: Long? = null,
    /** URI the renderer is playing (DLNA gapless detection). */
    val uri: String? = null,
    /** Track id the renderer is playing (queue-owning renderers: MixAI TVs). */
    val trackId: String? = null,
    /** 0..100. */
    val volume: Int? = null,
    val muted: Boolean? = null,
    /** Renderer reported a playback error (e.g. it could not open the stream). */
    val error: String? = null,
)

/**
 * Protocol side of a remote music output, driven by [ro.mixai.tv.player.RendererPlayer]. All calls are made
 * from one coroutine at a time (the player serialises them); implementations may block on IO.
 */
interface RemoteTransport {
    val target: OutputTarget

    /** True when the renderer keeps the whole queue and advances on its own (MixAI TVs). */
    val ownsQueue: Boolean get() = false
    val supportsVolume: Boolean get() = false
    /** Renderer can pre-load the next URI for gapless playback (DLNA SetNextAVTransportURI). */
    val supportsNext: Boolean get() = false

    /** Connects / validates the renderer; returns the mimes it plays (empty = unknown). Throws when unreachable. */
    suspend fun prepare(): Set<String>

    /**
     * Starts [queue] at [index] / [positionMs]. Renderers that do not own the queue get a single-item list.
     * [play] false = load paused (where the protocol allows it).
     */
    suspend fun load(queue: List<RemoteItem>, index: Int, positionMs: Long, play: Boolean, repeat: Int)

    /** Queue [item] as the next URI; false when not supported. */
    suspend fun setNext(item: RemoteItem?): Boolean = false

    suspend fun play()
    suspend fun pause()
    suspend fun stop()
    suspend fun seek(positionMs: Long)
    suspend fun next() {}
    suspend fun previous() {}
    suspend fun status(): RemoteStatus
    suspend fun setVolume(level: Int) {}
    suspend fun setMuted(muted: Boolean) {}
    fun release() {}
}
