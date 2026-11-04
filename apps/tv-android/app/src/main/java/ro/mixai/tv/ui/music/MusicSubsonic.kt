package ro.mixai.tv.ui.music

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import okhttp3.Request
import ro.mixai.tv.data.ApiException
import ro.mixai.tv.data.Http
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.generated.AlbumCard
import ro.mixai.tv.data.generated.MusicHome
import ro.mixai.tv.data.generated.TrackCard

// Gaps of the `/media/music` JSON API that the music screens need, filled from the OpenSubsonic
// API of the same server (same ids: `al_…`, `tr_…`, `pl_…`): playlist tracks, random songs for
// "Shuffle all" and the alphabetical album list for the Albums tab. Local to ui/music.
internal object MusicSubsonic {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private suspend fun call(api: MmoApi, method: String, params: String): JsonObject = withContext(Dispatchers.IO) {
        val url = api.withApiKey("/rest/$method.view?f=json&$params")
        Http.client.newCall(Request.Builder().url(url).header("Accept", "application/json").build()).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) throw ApiException(res.code, text.take(200))
            val r = json.parseToJsonElement(text).jsonObject["subsonic-response"]?.jsonObject ?: throw ApiException(0, "bad subsonic response")
            if (r.str("status") != "ok") throw ApiException(0, r["error"]?.let { (it as? JsonObject)?.str("message") } ?: "subsonic error")
            r
        }
    }

    /** Tracks of a playlist (`getPlaylist`). */
    suspend fun playlistTracks(api: MmoApi, playlistId: String): List<TrackCard> =
        call(api, "getPlaylist", "id=${api.encode(playlistId)}")["playlist"]?.obj()?.arr("entry")?.map { songToTrack(it.jsonObject) }.orEmpty()

    /** Random songs for "Shuffle all" (`getRandomSongs`). */
    suspend fun randomSongs(api: MmoApi, size: Int = 100): List<TrackCard> =
        call(api, "getRandomSongs", "size=$size")["randomSongs"]?.obj()?.arr("song")?.map { songToTrack(it.jsonObject) }.orEmpty()

    /** A–Z album page (`getAlbumList2?type=alphabeticalByName`). */
    suspend fun albums(api: MmoApi, offset: Int, size: Int = 60): List<AlbumCard> =
        call(api, "getAlbumList2", "type=alphabeticalByName&size=$size&offset=$offset")["albumList2"]?.obj()?.arr("album")
            ?.map { albumToCard(it.jsonObject) }.orEmpty()

    private fun songToTrack(o: JsonObject): TrackCard {
        val id = o.str("id").orEmpty()
        val cover = o.str("coverArt") ?: id
        return TrackCard(
            id = id,
            title = o.str("title").orEmpty(),
            artist = o.str("artist"),
            artistId = o.str("artistId"),
            album = o.str("album"),
            albumId = o.str("albumId").orEmpty(),
            track = o.long("track"),
            disc = o.long("discNumber"),
            year = o.long("year"),
            genre = o.str("genre"),
            durationSec = o.double("duration") ?: 0.0,
            format = o.str("suffix").orEmpty(),
            bitrate = o.long("bitRate"),
            coverArt = cover,
            coverUrlPath = "/rest/getCoverArt.view?id=${encode(cover)}&size=400",
            streamUrlPath = "/rest/stream.view?id=${encode(id)}",
        )
    }

    private fun albumToCard(o: JsonObject): AlbumCard {
        val id = o.str("id").orEmpty()
        val cover = o.str("coverArt") ?: id
        return AlbumCard(
            id = id,
            name = o.str("name") ?: o.str("album").orEmpty(),
            artist = o.str("artist"),
            artistId = o.str("artistId"),
            year = o.long("year"),
            genre = o.str("genre"),
            songCount = o.long("songCount") ?: 0L,
            durationSec = o.double("duration") ?: 0.0,
            coverArt = cover,
            coverUrlPath = "/rest/getCoverArt.view?id=${encode(cover)}&size=400",
        )
    }

    private fun encode(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
    private fun JsonElement.obj(): JsonObject? = this as? JsonObject
    private fun JsonObject.arr(k: String): JsonArray? = this[k] as? JsonArray
    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content?.takeIf { it.isNotEmpty() }
    private fun JsonObject.long(k: String): Long? = (this[k] as? JsonPrimitive)?.longOrNull
    private fun JsonObject.double(k: String): Double? = (this[k] as? JsonPrimitive)?.doubleOrNull
}

/** Last music home per profile so returning to Music shows rows instantly while it revalidates. */
internal object MusicHomeCache {
    @Volatile private var entry: Pair<String, MusicHome>? = null
    fun get(profile: String): MusicHome? = entry?.takeIf { it.first == profile }?.second
    fun put(profile: String, home: MusicHome) { entry = profile to home }
}

/** Cover URL of an album by id, identical to `AlbumCard.coverUrlPath` (same Coil cache key). */
internal fun MmoApi.albumCoverUrl(albumId: String): String = withApiKey("/rest/getCoverArt.view?id=${encode(albumId)}&size=400")

/** True when the home has nothing at all (no music library on the server). */
internal val MusicHome.isEmptyLibrary: Boolean
    get() = recent.isEmpty() && newest.isEmpty() && mostPlayed.isEmpty() && playlists.isEmpty() && randomAlbums.isEmpty()
