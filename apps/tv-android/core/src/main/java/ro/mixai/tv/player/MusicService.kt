package ro.mixai.tv.player

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionError
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import ro.mixai.core.R
import ro.mixai.tv.data.ClientIdentity
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.MusicRepository
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.generated.AlbumCard
import ro.mixai.tv.data.generated.ArtistCard
import ro.mixai.tv.data.generated.PlaylistCard
import ro.mixai.tv.data.generated.TrackCard

// Background music (WP16-21, WP17-41c): one ExoPlayer owned by a MediaLibraryService, so playback
// continues while the user browses and shows in the system now-playing, and the library is browsable
// by Android Auto, Assistant, Wear and other media browsers. The app talks to it through a
// MediaController (`data/MusicPlayback.kt`), whose items carry their stream URI in requestMetadata.
// Browse / voice requests carry ids from [MediaIds] (or a search query) and are expanded to queues
// by [MusicResolver] against the server saved in [Settings]. Session id "music" keeps it distinct
// from the video player's in-activity session (ids must be unique per process).
class MusicService : MediaLibraryService() {
    private var session: MediaLibrarySession? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var settings: Settings
    private var lib: Lib? = null
    private val searches = HashMap<String, List<MediaItem>>()

    /** Server-bound helpers, rebuilt when the saved connection or profile changes. */
    private class Lib(val key: String, val music: MusicRepository) {
        val resolver = MusicResolver(music)
    }

    @OptIn(UnstableApi::class)
    override fun onCreate() {
        super.onCreate()
        settings = Settings(applicationContext)
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent(ClientIdentity.current.userAgent)
            .setAllowCrossProtocolRedirects(true)
        val source: DataSource.Factory = dataSourceDecorator?.invoke(this, http) ?: http
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(source))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .build()
        session = MediaLibrarySession.Builder(this, player, Callback())
            .setId(SESSION_ID)
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        session?.run { player.release(); release() }
        session = null
        super.onDestroy()
    }

    // ─── server binding ───────────────────────────────────────────────────

    private suspend fun lib(): Lib? {
        val conn = settings.connection.first()
        if (!conn.isComplete) return null
        val profile = settings.activeProfile.first().id.ifBlank { "default" }
        val key = "${conn.baseUrl}|${conn.token}|$profile"
        lib?.takeIf { it.key == key }?.let { return it }
        searches.clear()
        return Lib(key, MusicRepository(MmoApi(conn.baseUrl, conn.token)) { profile }).also { lib = it }
    }

    private fun notConnected(): SessionError = SessionError(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED, getString(R.string.library_sign_in))

    private fun <T> future(block: suspend () -> T): ListenableFuture<T> {
        val f = SettableFuture.create<T>()
        scope.launch {
            try { f.set(block()) } catch (e: CancellationException) { f.cancel(false) } catch (e: Throwable) { f.setException(e) }
        }
        return f
    }

    /** Library call with errors mapped to a LibraryResult (Auto shows the message). */
    private fun <T : Any> libraryCall(params: LibraryParams?, block: suspend (Lib) -> LibraryResult<T>): ListenableFuture<LibraryResult<T>> = future {
        val l = lib() ?: return@future error(notConnected(), params)
        try { block(l) } catch (e: CancellationException) { throw e } catch (e: Exception) {
            Log.w(TAG, "library: ${e.message}")
            error(SessionError(SessionError.ERROR_UNKNOWN, getString(R.string.library_error)), params)
        }
    }

    private fun <T : Any> error(e: SessionError, params: LibraryParams?): LibraryResult<T> =
        if (params != null) LibraryResult.ofError(e, params) else LibraryResult.ofError(e)

    // ─── items ────────────────────────────────────────────────────────────

    private fun styleExtras(grid: Boolean) = Bundle().apply {
        putInt(
            MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE,
            if (grid) MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM else MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
        )
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
    }

    private fun folder(node: MusicNode, title: String, subtitle: String? = null, art: String? = null, playable: Boolean = false, grid: Boolean = false): MediaItem =
        MediaItem.Builder()
            .setMediaId(MediaIds.encode(node))
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setArtworkUri(art?.let(Uri::parse))
                    .setIsBrowsable(!playable)
                    .setIsPlayable(playable)
                    .setMediaType(
                        when (node) {
                            is MusicNode.Album -> MediaMetadata.MEDIA_TYPE_ALBUM
                            is MusicNode.Artist -> MediaMetadata.MEDIA_TYPE_ARTIST
                            is MusicNode.Playlist -> MediaMetadata.MEDIA_TYPE_PLAYLIST
                            is MusicNode.Radio, MusicNode.Mix -> MediaMetadata.MEDIA_TYPE_RADIO_STATION
                            else -> MediaMetadata.MEDIA_TYPE_FOLDER_MIXED
                        },
                    )
                    .setExtras(styleExtras(grid))
                    .build(),
            )
            .build()

    private fun Lib.album(a: AlbumCard, group: String? = null) =
        folder(MusicNode.Album(a.id), a.name, a.artist, music.coverUrl(a), grid = true).withGroup(group)

    private fun Lib.artist(a: ArtistCard, group: String? = null) =
        folder(MusicNode.Artist(a.id), a.name, null, music.coverUrl(a), grid = true).withGroup(group)

    private fun Lib.playlist(p: PlaylistCard) =
        folder(MusicNode.Playlist(p.id), p.name, getString(R.string.library_tracks, p.songCount.toInt()), music.coverUrl(p))

    /** Browse entry for a track: same metadata as the queue item, a [MediaIds] id and no URI. */
    private fun Lib.track(t: TrackCard, ctx: TrackContext, group: String? = null): MediaItem {
        val base = queueItem(t)
        return MediaItem.Builder()
            .setMediaId(MediaIds.encode(MusicNode.Track(t.id, ctx)))
            .setMediaMetadata(base.mediaMetadata)
            .build()
            .withGroup(group)
    }

    private fun MediaItem.withGroup(group: String?): MediaItem {
        if (group == null) return this
        val extras = Bundle(mediaMetadata.extras ?: Bundle()).apply { putString(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE, group) }
        return buildUpon().setMediaMetadata(mediaMetadata.buildUpon().setExtras(extras).build()).build()
    }

    /** Playable queue item (bare server id, real stream URI) — what the player and the app hold. */
    private fun Lib.queueItem(t: TrackCard): MediaItem = TrackItems.toItem(t, music.streamUrl(t), music.coverUrl(t)?.let(Uri::parse))

    private fun Lib.positioned(r: Resolved): MediaSession.MediaItemsWithStartPosition =
        MediaSession.MediaItemsWithStartPosition(r.tracks.map { queueItem(it) }, r.start.coerceIn(0, r.tracks.lastIndex), C.TIME_UNSET)

    private fun page(list: List<MediaItem>, page: Int, size: Int): List<MediaItem> {
        if (size <= 0 || page < 0) return list
        val from = page.toLong() * size
        if (from >= list.size) return emptyList()
        return list.subList(from.toInt(), minOf(list.size, (from + size).toInt()))
    }

    private suspend fun Lib.children(node: MusicNode, page: Int, size: Int): List<MediaItem> = when (node) {
        MusicNode.Root -> listOf(
            folder(MusicNode.Home, getString(R.string.library_home)),
            folder(MusicNode.Playlists, getString(R.string.library_playlists)),
            folder(MusicNode.Artists, getString(R.string.library_artists)),
        )
        MusicNode.Home -> page(homeItems(), page, size)
        MusicNode.Playlists -> {
            val lists = try { music.playlists() } catch (e: CancellationException) { throw e } catch (e: Exception) { music.home().playlists }
            page(lists.distinctBy { it.id }.map { playlist(it) }, page, size)
        }
        MusicNode.Artists -> {
            val limit = if (size > 0) size else 200
            music.artists(offset = maxOf(page, 0) * limit, limit = limit).items.distinctBy { it.id }.map { artist(it) }
        }
        is MusicNode.Album -> page(music.album(node.id).tracks.distinctBy { it.id }.map { track(it, TrackContext.Album(node.id)) }, page, size)
        is MusicNode.Playlist -> page(music.playlistTracks(node.id).distinctBy { it.id }.map { track(it, TrackContext.Playlist(node.id)) }, page, size)
        is MusicNode.Artist -> {
            val d = music.artist(node.id)
            val top = getString(R.string.library_top_tracks)
            val albums = getString(R.string.library_albums)
            page(
                listOf(folder(MusicNode.Radio(node.id), getString(R.string.library_artist_radio, d.artist.name), playable = true)) +
                    d.topTracks.distinctBy { it.id }.take(10).map { track(it, TrackContext.Artist(node.id), top) } +
                    d.albums.distinctBy { it.id }.map { album(it, albums) },
                page, size,
            )
        }
        MusicNode.Mix, is MusicNode.Radio, is MusicNode.Track -> emptyList()
    }

    private suspend fun Lib.homeItems(): List<MediaItem> {
        val h = music.home()
        val recent = getString(R.string.library_recent)
        val newest = getString(R.string.library_newest)
        val most = getString(R.string.library_most_played)
        val discover = getString(R.string.library_discover)
        val seen = HashSet<String>()
        fun fresh(a: AlbumCard) = seen.add(a.id)
        return listOf(folder(MusicNode.Mix, getString(R.string.library_mix), getString(R.string.library_mix_hint), playable = true)) +
            h.recent.filter(::fresh).map { album(it, recent) } +
            h.mostPlayed.distinctBy { it.id }.take(10).map { track(it, TrackContext.MostPlayed, most) } +
            h.newest.filter(::fresh).map { album(it, newest) } +
            h.randomAlbums.filter(::fresh).map { album(it, discover) }
    }

    private suspend fun Lib.searchItems(query: String): List<MediaItem> {
        searches[query]?.let { return it }
        val s = music.search(query)
        val items = s.tracks.distinctBy { it.id }.map { track(it, TrackContext.Search(query), getString(R.string.library_tracks_group)) } +
            s.albums.distinctBy { it.id }.map { album(it, getString(R.string.library_albums)) } +
            s.artists.distinctBy { it.id }.map { artist(it, getString(R.string.library_artists)) }
        if (searches.size > 8) searches.clear()
        searches[query] = items
        return items
    }

    // ─── session callback ─────────────────────────────────────────────────

    private inner class Callback : MediaLibrarySession.Callback {
        override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> {
            val recent = params?.isRecent == true
            val root = MediaItem.Builder()
                .setMediaId(if (recent) RECENT_ID else MediaIds.encode(MusicNode.Root))
                .setMediaMetadata(MediaMetadata.Builder().setIsBrowsable(true).setIsPlayable(false).setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build())
                .build()
            return Futures.immediateFuture(LibraryResult.ofItem(root, LibraryParams.Builder().setExtras(styleExtras(grid = true)).setRecent(recent).build()))
        }

        override fun onGetChildren(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
            if (parentId == RECENT_ID) {
                // Most recent playable item for the system "resume" surfaces (Auto, Bluetooth).
                return Futures.immediateFuture(LibraryResult.ofItemList(listOfNotNull(session.player.currentMediaItem), params))
            }
            val node = MediaIds.decode(parentId)
                ?: return Futures.immediateFuture(error(SessionError(SessionError.ERROR_BAD_VALUE, "unknown id"), params))
            return libraryCall(params) { l -> LibraryResult.ofItemList(l.children(node, page, pageSize), params) }
        }

        override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> {
            val item = when (MediaIds.decode(mediaId)) {
                MusicNode.Root, MusicNode.Home -> folder(MusicNode.Home, getString(R.string.library_home))
                MusicNode.Playlists -> folder(MusicNode.Playlists, getString(R.string.library_playlists))
                MusicNode.Artists -> folder(MusicNode.Artists, getString(R.string.library_artists))
                MusicNode.Mix -> folder(MusicNode.Mix, getString(R.string.library_mix), playable = true)
                else -> null
            }
            return Futures.immediateFuture(if (item != null) LibraryResult.ofItem(item, null) else LibraryResult.ofError(SessionError.ERROR_NOT_SUPPORTED))
        }

        override fun onSearch(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> =
            libraryCall(params) { l ->
                val n = l.searchItems(query.trim()).size
                session.notifySearchResultChanged(browser, query, n, params)
                LibraryResult.ofVoid(params)
            }

        override fun onGetSearchResult(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, page: Int, pageSize: Int, params: LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
            libraryCall(params) { l -> LibraryResult.ofItemList(page(l.searchItems(query.trim()), page, pageSize), params) }

        // App items already carry their URI (requestMetadata.mediaUri: controllers cannot send it as
        // localConfiguration). Browse ids expand to their tracks; anything else is a voice request.
        override fun onAddMediaItems(
            mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> {
            if (mediaItems.all { it.hasUri() }) return Futures.immediateFuture(mediaItems.map { it.withUri() }.toMutableList())
            return future {
                val l = lib() ?: return@future mutableListOf()
                mediaItems.flatMap { if (it.hasUri()) listOf(it.withUri()) else l.resolve(it)?.tracks?.map { t -> l.queueItem(t) }.orEmpty() }.toMutableList()
            }
        }

        override fun onSetMediaItems(
            mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            if (mediaItems.all { it.hasUri() }) {
                return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(mediaItems.map { it.withUri() }, startIndex, startPositionMs))
            }
            return future {
                val l = lib() ?: throw IllegalStateException("not connected")
                val single = mediaItems.singleOrNull()
                if (single != null) return@future l.positioned(l.resolve(single) ?: throw IllegalStateException("nothing to play"))
                val items = mediaItems.flatMap { if (it.hasUri()) listOf(it.withUri()) else l.resolve(it)?.tracks?.map { t -> l.queueItem(t) }.orEmpty() }
                MediaSession.MediaItemsWithStartPosition(items, startIndex.coerceIn(0, maxOf(items.lastIndex, 0)), startPositionMs)
            }
        }

        // "Play music on MixAI Music" with nothing queued, Bluetooth play after a reboot → a mix.
        override fun onPlaybackResumption(
            mediaSession: MediaSession, controller: MediaSession.ControllerInfo, isForPlayback: Boolean,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = future {
            val l = lib() ?: throw IllegalStateException("not connected")
            l.positioned(l.resolver.node(MusicNode.Mix) ?: throw IllegalStateException("empty library"))
        }
    }

    private fun MediaItem.hasUri(): Boolean = localConfiguration != null || requestMetadata.mediaUri != null

    private fun MediaItem.withUri(): MediaItem {
        val uri = requestMetadata.mediaUri
        // localConfiguration (URI, cache key) never crosses the controller boundary: rebuild both.
        return if (localConfiguration == null && uri != null) buildUpon().setUri(uri).setCustomCacheKey(TrackItems.cacheKey(mediaId)).build() else this
    }

    /** Browse id → its queue; otherwise a voice request (search query + Assistant focus extras). */
    private suspend fun Lib.resolve(item: MediaItem): Resolved? {
        MediaIds.decode(item.mediaId)?.let { return resolver.node(it) }
        val extras = item.requestMetadata.extras
        val query = item.requestMetadata.searchQuery
            ?: extras?.getString(MediaStore.EXTRA_MEDIA_ARTIST)
            ?: extras?.getString(MediaStore.EXTRA_MEDIA_ALBUM)
            ?: extras?.getString(MediaStore.EXTRA_MEDIA_TITLE)
        return resolver.voice(query, MusicResolver.focusOf(extras?.getString(MediaStore.EXTRA_MEDIA_FOCUS)))
    }

    companion object {
        const val SESSION_ID = "music"
        private const val RECENT_ID = "recent"
        private const val TAG = "MusicService"

        /**
         * Set once by an app (MixAI Music, before the service starts) to read downloaded tracks from its
         * cache: receives the network factory, returns the factory the player uses. Null = network only.
         */
        @Volatile var dataSourceDecorator: ((android.content.Context, DataSource.Factory) -> DataSource.Factory)? = null
    }
}
