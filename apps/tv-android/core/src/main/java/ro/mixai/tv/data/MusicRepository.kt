package ro.mixai.tv.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import ro.mixai.tv.data.generated.AlbumCard
import ro.mixai.tv.data.generated.AlbumDetail
import ro.mixai.tv.data.generated.ArtistCard
import ro.mixai.tv.data.generated.ArtistDetail
import ro.mixai.tv.data.generated.ArtistPage
import ro.mixai.tv.data.generated.GenreCard
import ro.mixai.tv.data.generated.Lyrics
import ro.mixai.tv.data.generated.MusicHome
import ro.mixai.tv.data.generated.MusicQueue
import ro.mixai.tv.data.generated.MusicQueueInput
import ro.mixai.tv.data.generated.MusicSearch
import ro.mixai.tv.data.generated.PlaylistCard
import ro.mixai.tv.data.generated.TrackCard
import ro.mixai.tv.player.MusicSource

// Music JSON API (`/media/music/*`, WP16-11). Covers + streams are Subsonic URLs that need the
// device token as `apiKey` (`MmoApi.withApiKey`) because Coil/Media3 cannot send headers per item.
class MusicRepository(private val api: MmoApi, private val profileId: () -> String = { "default" }) : MusicSource {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true; explicitNulls = false }
    // Request bodies: defaults must be written (an empty `trackIds` equals its default and was dropped →
    // server 400 "trackIds must be an array"); nulls stay out.
    private val bodyJson = Json { encodeDefaults = true; explicitNulls = false }
    private val profile: String get() = profileId().ifBlank { "default" }

    override suspend fun home(): MusicHome = json.decodeFromString(api.getJson("/media/music/home?profile=${api.encode(profile)}"))

    /** Artists A–Z; `letter` = initial (`#` for non-letters as the server defines it). */
    suspend fun artists(letter: String? = null, offset: Int = 0, limit: Int = 200): ArtistPage {
        val qs = buildString {
            append("/media/music/artists?offset=").append(offset).append("&limit=").append(limit)
            if (!letter.isNullOrBlank()) append("&letter=").append(api.encode(letter))
        }
        return json.decodeFromString(api.getJson(qs))
    }

    override suspend fun artist(id: String): ArtistDetail = json.decodeFromString(api.getJson("/media/music/artists/${api.encode(id)}"))

    override suspend fun album(id: String): AlbumDetail = json.decodeFromString(api.getJson("/media/music/albums/${api.encode(id)}"))

    suspend fun genres(): List<GenreCard> =
        json.parseToJsonElement(api.getJson("/media/music/genres")).jsonObject["genres"]?.jsonArray
            ?.map { json.decodeFromJsonElement(GenreCard.serializer(), it) } ?: emptyList()

    suspend fun genre(name: String, offset: Int = 0, limit: Int = 100): GenreAlbums =
        json.decodeFromString(api.getJson("/media/music/genres/${api.encode(name)}?offset=$offset&limit=$limit"))

    override suspend fun search(q: String): MusicSearch = json.decodeFromString(api.getJson("/media/music/search?q=${api.encode(q)}"))

    /** `GET /media/music/playlists` (server 3.10+). */
    suspend fun playlists(): List<PlaylistCard> = listField("playlists", PlaylistCard.serializer(), "/media/music/playlists")

    /** `GET /media/music/playlists/{id}` tracks in order (server 3.10+). */
    override suspend fun playlistTracks(id: String): List<TrackCard> = listField("tracks", TrackCard.serializer(), "/media/music/playlists/${api.encode(id)}")

    /** `GET /media/music/random?size=` (1..500). */
    override suspend fun random(size: Int): List<TrackCard> = listField("tracks", TrackCard.serializer(), "/media/music/random?size=${size.coerceIn(1, 500)}")

    /** `GET /media/music/radio?seed=tr_|al_|ar_&size=` — a track seed comes first. */
    override suspend fun radio(seed: String, size: Int): List<TrackCard> =
        listField("tracks", TrackCard.serializer(), "/media/music/radio?seed=${api.encode(seed)}&size=${size.coerceIn(1, 200)}")

    private suspend fun <T> listField(key: String, s: kotlinx.serialization.KSerializer<T>, path: String): List<T> =
        json.parseToJsonElement(api.getJson(path)).jsonObject[key]?.jsonArray?.map { json.decodeFromJsonElement(s, it) } ?: emptyList()

    /** Tracks by id in the requested order (server >= 3.12; older servers ignore `ids` and the caller gets a page). */
    suspend fun tracksByIds(ids: List<String>): List<TrackCard> {
        if (ids.isEmpty()) return emptyList()
        val out = ArrayList<TrackCard>(ids.size)
        for (chunk in ids.chunked(200)) {
            val body = api.getJson("/media/music/tracks?ids=" + api.encode(chunk.joinToString(",")))
            val items = json.decodeFromString<TrackPage>(body).items
            val byId = items.associateBy { it.id }
            // Server < 3.12 returns the A-Z page instead: keep only the ids that were asked for.
            chunk.mapNotNullTo(out) { byId[it] }
        }
        return out
    }

    @kotlinx.serialization.Serializable
    private data class TrackPage(val items: List<TrackCard> = emptyList())

    suspend fun queue(): MusicQueue = json.decodeFromString(api.getJson("/media/music/queue?profile=${api.encode(profile)}"))

    suspend fun putQueue(input: MusicQueueInput): MusicQueue =
        json.decodeFromString(api.putJson("/media/music/queue?profile=${api.encode(profile)}", bodyJson.encodeToString(MusicQueueInput.serializer(), input)))

    /** 404 → null (no lyrics). */
    suspend fun lyrics(trackId: String): Lyrics? = try {
        json.decodeFromString<Lyrics>(api.getJson("/media/music/lyrics/${api.encode(trackId)}"))
    } catch (e: ApiException) {
        if (e.status == 404) null else throw e
    }

    // ─── URLs ─────────────────────────────────────────────────────────────

    fun coverUrl(card: AlbumCard): String? = card.coverUrlPath.takeIf { it.isNotBlank() }?.let(api::withApiKey)
    fun coverUrl(card: TrackCard): String? = card.coverUrlPath.takeIf { it.isNotBlank() }?.let(api::withApiKey)
    fun coverUrl(card: ArtistCard): String? = card.coverUrlPath.takeIf { it.isNotBlank() }?.let(api::withApiKey)
    fun coverUrl(card: PlaylistCard): String? = card.coverUrlPath?.takeIf { it.isNotBlank() }?.let(api::withApiKey)
    /** Cover by Subsonic cover-art id at a given size (px). */
    fun coverUrl(coverArt: String?, size: Int = 400): String? = api.coverArtUrl(coverArt?.takeIf { it.isNotBlank() }, size)

    fun streamUrl(track: TrackCard): String =
        track.streamUrlPath.takeIf { it.isNotBlank() }?.let(api::withApiKey) ?: api.streamUrl(track.id)
}
