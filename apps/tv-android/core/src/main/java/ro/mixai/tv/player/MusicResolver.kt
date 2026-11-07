package ro.mixai.tv.player

import ro.mixai.tv.data.generated.AlbumDetail
import ro.mixai.tv.data.generated.ArtistDetail
import ro.mixai.tv.data.generated.MusicHome
import ro.mixai.tv.data.generated.MusicSearch
import ro.mixai.tv.data.generated.TrackCard

/** The slice of the music API the resolver needs (MusicRepository implements it; tests fake it). */
interface MusicSource {
    suspend fun home(): MusicHome
    suspend fun album(id: String): AlbumDetail
    suspend fun artist(id: String): ArtistDetail
    suspend fun playlistTracks(id: String): List<TrackCard>
    suspend fun random(size: Int = 50): List<TrackCard>
    suspend fun radio(seed: String, size: Int = 50): List<TrackCard>
    suspend fun search(q: String): MusicSearch
}

/** A queue to play and where to start. */
data class Resolved(val tracks: List<TrackCard>, val start: Int = 0)

/** What a voice request is about (Assistant `EXTRA_MEDIA_FOCUS`). */
enum class VoiceFocus { Any, Artist, Album }

/**
 * Turns browse-tree selections and voice queries into queues (WP17-41c). Pure: no Android types, so the
 * rules are unit-tested. Empty voice query ("Play music on MixAI Music") starts a mix right away.
 */
class MusicResolver(private val src: MusicSource) {

    suspend fun node(node: MusicNode): Resolved? = when (node) {
        MusicNode.Mix -> Resolved(src.random(MIX_SIZE))
        is MusicNode.Radio -> Resolved(radio(node.seed))
        is MusicNode.Album -> Resolved(src.album(node.id).tracks)
        is MusicNode.Playlist -> Resolved(src.playlistTracks(node.id))
        is MusicNode.Artist -> Resolved(src.artist(node.id).topTracks)
        is MusicNode.Track -> track(node)
        MusicNode.Root, MusicNode.Home, MusicNode.Playlists, MusicNode.Artists -> null
    }?.takeIf { it.tracks.isNotEmpty() }

    /** The track inside its list (album, playlist, …); a track outside any list plays a radio seeded by it. */
    private suspend fun track(node: MusicNode.Track): Resolved {
        val list = when (val c = node.context) {
            is TrackContext.Album -> src.album(c.id).tracks
            is TrackContext.Playlist -> src.playlistTracks(c.id)
            is TrackContext.Artist -> src.artist(c.id).topTracks
            TrackContext.MostPlayed -> src.home().mostPlayed
            is TrackContext.Search -> src.search(c.query).tracks
            TrackContext.Single -> emptyList()
        }.distinctBy { it.id }
        val i = list.indexOfFirst { it.id == node.trackId }
        return if (i >= 0) Resolved(list, i) else Resolved(radio(node.trackId))
    }

    /** Server radio (3.10+); older servers answer 404 → a random mix instead of nothing. */
    private suspend fun radio(seed: String): List<TrackCard> =
        runCatching { src.radio(seed, RADIO_SIZE) }.getOrElse { e ->
            if (e is kotlinx.coroutines.CancellationException) throw e
            src.random(MIX_SIZE)
        }

    /**
     * Voice search. Artist focus → artist radio; album focus → the album; otherwise matching tracks,
     * then the first album, then the first artist's radio. Blank query with no focus → mix.
     */
    suspend fun voice(query: String?, focus: VoiceFocus = VoiceFocus.Any): Resolved? {
        val q = query?.trim().orEmpty()
        if (q.isEmpty()) return node(MusicNode.Mix)
        val s = src.search(q)
        val artist = s.artists.firstOrNull()
        val album = s.albums.firstOrNull()
        val r = when {
            focus == VoiceFocus.Artist && artist != null -> Resolved(radio(artist.id))
            focus == VoiceFocus.Album && album != null -> Resolved(src.album(album.id).tracks)
            s.tracks.isNotEmpty() -> Resolved(s.tracks.distinctBy { it.id })
            album != null -> Resolved(src.album(album.id).tracks)
            artist != null -> Resolved(radio(artist.id))
            else -> null
        }
        return r?.takeIf { it.tracks.isNotEmpty() }
    }

    companion object {
        const val MIX_SIZE = 100
        const val RADIO_SIZE = 50
        /** `MediaStore.Audio.Artists.ENTRY_CONTENT_TYPE` / `Albums.ENTRY_CONTENT_TYPE`. */
        fun focusOf(mediaFocus: String?): VoiceFocus = when (mediaFocus) {
            "vnd.android.cursor.item/artist" -> VoiceFocus.Artist
            "vnd.android.cursor.item/album" -> VoiceFocus.Album
            else -> VoiceFocus.Any
        }
    }
}
