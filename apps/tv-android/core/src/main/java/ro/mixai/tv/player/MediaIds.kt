package ro.mixai.tv.player

import java.net.URLDecoder
import java.net.URLEncoder

/** Where a playable track came from, so selecting it plays the whole surrounding list. */
sealed interface TrackContext {
    data class Album(val id: String) : TrackContext
    data class Playlist(val id: String) : TrackContext
    data class Artist(val id: String) : TrackContext
    data object MostPlayed : TrackContext
    data class Search(val query: String) : TrackContext
    data object Single : TrackContext
}

/** Nodes of the MediaLibraryService browse tree (Android Auto, Assistant, Wear, other browsers). */
sealed interface MusicNode {
    data object Root : MusicNode
    data object Home : MusicNode
    data object Playlists : MusicNode
    data object Artists : MusicNode
    /** Playable: random tracks ("shuffle all"); also what an empty voice query plays. */
    data object Mix : MusicNode
    data class Album(val id: String) : MusicNode
    data class Playlist(val id: String) : MusicNode
    data class Artist(val id: String) : MusicNode
    /** Playable: server radio from a `tr_`/`al_`/`ar_` seed. */
    data class Radio(val seed: String) : MusicNode
    data class Track(val trackId: String, val context: TrackContext) : MusicNode
}

/**
 * Stable string ids for [MusicNode]s. Queue items (what the player holds) use the bare server track id
 * instead, so the app's MusicPlayback can match them; only browse/search results carry these ids.
 */
object MediaIds {
    private const val SEP = "/"

    fun encode(node: MusicNode): String = when (node) {
        MusicNode.Root -> "root"
        MusicNode.Home -> "home"
        MusicNode.Playlists -> "playlists"
        MusicNode.Artists -> "artists"
        MusicNode.Mix -> "mix"
        is MusicNode.Album -> "album$SEP${enc(node.id)}"
        is MusicNode.Playlist -> "playlist$SEP${enc(node.id)}"
        is MusicNode.Artist -> "artist$SEP${enc(node.id)}"
        is MusicNode.Radio -> "radio$SEP${enc(node.seed)}"
        is MusicNode.Track -> "track$SEP${enc(node.trackId)}$SEP${encodeContext(node.context)}"
    }

    fun decode(id: String?): MusicNode? {
        if (id.isNullOrBlank()) return null
        val parts = id.split(SEP)
        val arg = parts.getOrNull(1)?.let(::dec)?.takeIf { it.isNotBlank() }
        return when (parts[0]) {
            "root" -> MusicNode.Root
            "home" -> MusicNode.Home
            "playlists" -> MusicNode.Playlists
            "artists" -> MusicNode.Artists
            "mix" -> MusicNode.Mix
            "album" -> arg?.let { MusicNode.Album(it) }
            "playlist" -> arg?.let { MusicNode.Playlist(it) }
            "artist" -> arg?.let { MusicNode.Artist(it) }
            "radio" -> arg?.let { MusicNode.Radio(it) }
            "track" -> arg?.let { MusicNode.Track(it, decodeContext(parts.getOrNull(2))) }
            else -> null
        }
    }

    private fun encodeContext(c: TrackContext): String = when (c) {
        is TrackContext.Album -> "al.${enc(c.id)}"
        is TrackContext.Playlist -> "pl.${enc(c.id)}"
        is TrackContext.Artist -> "ar.${enc(c.id)}"
        TrackContext.MostPlayed -> "mp"
        is TrackContext.Search -> "q.${enc(c.query)}"
        TrackContext.Single -> "one"
    }

    private fun decodeContext(s: String?): TrackContext {
        if (s == null) return TrackContext.Single
        val kind = s.substringBefore('.')
        val arg = dec(s.substringAfter('.', ""))
        return when (kind) {
            "al" -> if (arg.isNotBlank()) TrackContext.Album(arg) else TrackContext.Single
            "pl" -> if (arg.isNotBlank()) TrackContext.Playlist(arg) else TrackContext.Single
            "ar" -> if (arg.isNotBlank()) TrackContext.Artist(arg) else TrackContext.Single
            "mp" -> TrackContext.MostPlayed
            "q" -> TrackContext.Search(arg)
            else -> TrackContext.Single
        }
    }

    /** Index of [trackId] in [ids], 0 when absent (play the list from the start). */
    fun startIndex(ids: List<String>, trackId: String): Int = ids.indexOf(trackId).coerceAtLeast(0)

    // URL-encoding keeps "/" and "." inside ids/queries from breaking the separators.
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace(".", "%2E")
    private fun dec(s: String) = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)
}
