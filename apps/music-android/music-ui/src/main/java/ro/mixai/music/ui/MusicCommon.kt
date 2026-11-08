package ro.mixai.music.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Notes
import androidx.compose.material.icons.outlined.Album
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import okhttp3.Request
import ro.mixai.music.ui.R
import ro.mixai.tv.data.ApiException
import ro.mixai.tv.data.Http
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.generated.AlbumCard
import ro.mixai.tv.data.generated.MusicHome
import ro.mixai.tv.data.generated.TrackCard

// Gaps of the `/media/music` JSON API filled from the OpenSubsonic API of the same server
// (same ids): playlist tracks, random songs and the A–Z album list. Ported from the TV app.
internal object PhoneSubsonic {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private suspend fun call(api: MmoApi, method: String, params: String): JsonObject = withContext(Dispatchers.IO) {
        val url = api.withApiKey("/rest/$method.view?f=json&$params")
        Http.client.newCall(Request.Builder().url(url).header("Accept", "application/json").build()).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) throw ApiException(res.code, text.take(200))
            val r = json.parseToJsonElement(text).jsonObject["subsonic-response"]?.jsonObject ?: throw ApiException(0, "bad subsonic response")
            if (r.str("status") != "ok") throw ApiException(0, (r["error"] as? JsonObject)?.str("message") ?: "subsonic error")
            r
        }
    }

    suspend fun playlistTracks(api: MmoApi, playlistId: String): List<TrackCard> =
        (call(api, "getPlaylist", "id=${api.encode(playlistId)}")["playlist"] as? JsonObject)?.arr("entry")
            ?.map { songToTrack(it.jsonObject) }.orEmpty()

    suspend fun randomSongs(api: MmoApi, size: Int = 100): List<TrackCard> =
        (call(api, "getRandomSongs", "size=$size")["randomSongs"] as? JsonObject)?.arr("song")
            ?.map { songToTrack(it.jsonObject) }.orEmpty()

    suspend fun albums(api: MmoApi, offset: Int, size: Int = 60): List<AlbumCard> =
        (call(api, "getAlbumList2", "type=alphabeticalByName&size=$size&offset=$offset")["albumList2"] as? JsonObject)?.arr("album")
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
            coverUrlPath = "/rest/getCoverArt.view?id=${enc(cover)}&size=400",
            streamUrlPath = "/rest/stream.view?id=${enc(id)}",
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
            coverUrlPath = "/rest/getCoverArt.view?id=${enc(cover)}&size=400",
        )
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
    private fun JsonObject.arr(k: String): JsonArray? = this[k] as? JsonArray
    private fun JsonObject.str(k: String): String? =
        (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content?.takeIf { it.isNotEmpty() }
    private fun JsonObject.long(k: String): Long? = (this[k] as? JsonPrimitive)?.longOrNull
    private fun JsonObject.double(k: String): Double? = (this[k] as? JsonPrimitive)?.doubleOrNull
}

/** Last music home so returning to the tab paints instantly while it revalidates. */
internal object PhoneMusicCache {
    @Volatile var home: MusicHome? = null
}

internal val MusicHome.isEmptyLibrary: Boolean
    get() = recent.isEmpty() && newest.isEmpty() && mostPlayed.isEmpty() && playlists.isEmpty() && randomAlbums.isEmpty()

/** m:ss or h:mm:ss. */
internal fun fmtDuration(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

internal fun fmtSec(sec: Double): String = fmtDuration((sec * 1000).toLong())

/** Square (or round) cover with an icon placeholder underneath. */
@Composable
fun Cover(url: String?, modifier: Modifier = Modifier, shape: Shape = MaterialTheme.shapes.small, icon: ImageVector = Icons.Outlined.Album) {
    Box(
        modifier.clip(shape).background(MaterialTheme.colorScheme.surfaceContainerHighest),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(28.dp))
        if (!url.isNullOrBlank()) {
            AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
    }
}

/** Album tile: square cover, name, artist. */
@Composable
internal fun AlbumTile(cover: String?, album: AlbumCard, onClick: () -> Unit, modifier: Modifier = Modifier, width: Dp? = 148.dp) {
    Column(
        (if (width != null) modifier.width(width) else modifier.fillMaxWidth())
            .focusClickable(onClick = onClick)
            .clip(MaterialTheme.shapes.small),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Cover(cover, Modifier.fillMaxWidth().aspectRatio(1f))
        Text(album.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            album.artist.orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Track row: number or cover, title/artist, lyrics badge, duration. */
@Composable
fun TrackRow(
    track: TrackCard,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    number: String? = null,
    cover: String? = null,
    current: Boolean = false,
    offline: OfflineState? = null,
) {
    Row(
        modifier.fillMaxWidth().focusClickable(scaleOnFocus = false, onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val accent = if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface
        if (cover != null) {
            Cover(cover, Modifier.size(48.dp), icon = Icons.Outlined.MusicNote)
        } else if (number != null) {
            Text(
                number, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.width(28.dp), maxLines = 1,
            )
        }
        Column(Modifier.weight(1f)) {
            Text(
                track.title, style = MaterialTheme.typography.bodyLarge, color = accent,
                fontWeight = if (current) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            val sub = listOfNotNull(track.artist, track.album.takeIf { cover != null }).joinToString(" · ")
            if (sub.isNotBlank()) {
                Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        OfflineBadge(offline)
        if (track.hasLyrics || track.hasSyncedLyrics) {
            Icon(
                Icons.AutoMirrored.Outlined.Notes, contentDescription = stringResource(R.string.music_has_lyrics),
                tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp),
            )
        }
        if (track.durationSec > 0) {
            Text(fmtSec(track.durationSec), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Round artist avatar. */
@Composable
internal fun ArtistAvatar(url: String?, size: Dp, modifier: Modifier = Modifier) {
    Cover(url, modifier.size(size), shape = CircleShape, icon = Icons.Outlined.Person)
}
