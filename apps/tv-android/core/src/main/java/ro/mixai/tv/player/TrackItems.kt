package ro.mixai.tv.player

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import kotlinx.serialization.json.Json
import ro.mixai.tv.data.generated.TrackCard

/**
 * TrackCard ⇄ MediaItem. The card travels as JSON in the metadata extras so any controller (the app's
 * MusicPlayback after Android Auto / Assistant built the queue) can rebuild its queue from the player.
 */
object TrackItems {
    const val EXTRA_TRACK = "ro.mixai.track"
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    /** Cache key shared by track downloads and the player (`track:<id>`), so downloaded bytes play offline. */
    fun cacheKey(trackId: String) = "track:$trackId"

    fun toItem(t: TrackCard, streamUrl: String, artwork: Uri?): MediaItem {
        val uri = Uri.parse(streamUrl)
        return MediaItem.Builder()
            .setMediaId(t.id)
            .setUri(uri)
            .setCustomCacheKey(cacheKey(t.id))
            .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(uri).build())
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(t.title)
                    .setArtist(t.artist)
                    .setAlbumTitle(t.album)
                    .setArtworkUri(artwork)
                    .setDurationMs((t.durationSec * 1000).toLong().takeIf { it > 0 })
                    .setTrackNumber(t.track?.toInt())
                    .setDiscNumber(t.disc?.toInt())
                    .setReleaseYear(t.year?.toInt())
                    .setGenre(t.genre)
                    .setIsPlayable(true)
                    .setIsBrowsable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                    .setExtras(Bundle().apply { putString(EXTRA_TRACK, json.encodeToString(TrackCard.serializer(), t)) })
                    .build(),
            )
            .build()
    }

    /** The card stored by [toItem], or a minimal card from the visible metadata. */
    fun fromItem(item: MediaItem): TrackCard? {
        item.mediaMetadata.extras?.getString(EXTRA_TRACK)?.let { s ->
            runCatching { return json.decodeFromString(TrackCard.serializer(), s) }
        }
        if (item.mediaId.isBlank()) return null
        val m = item.mediaMetadata
        return TrackCard(
            id = item.mediaId,
            title = m.title?.toString().orEmpty(),
            artist = m.artist?.toString(),
            album = m.albumTitle?.toString(),
            durationSec = (m.durationMs ?: 0L) / 1000.0,
        )
    }
}
