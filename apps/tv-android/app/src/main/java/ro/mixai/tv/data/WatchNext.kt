package ro.mixai.tv.data

import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.util.Log
import androidx.tvprovider.media.tv.TvContractCompat
import androidx.tvprovider.media.tv.WatchNextProgram
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ro.mixai.tv.data.generated.TitleCard

// Publishes the server `continue` row into the Android TV "Watch Next" channel (WP12-01).
// Each program deep-links back with `mixai://title/<kind>/<tmdbId>`, handled by MainActivity.
// Existing programs are matched on `internalProviderId` (`<kind>:<tmdbId>`) and updated in place;
// programs no longer in the row are removed. Silently no-ops on devices without the TV provider.
object WatchNext {
    private const val TAG = "WatchNext"

    fun deepLink(kind: String, tmdbId: Long): Uri = Uri.parse("mixai://title/$kind/$tmdbId")

    suspend fun publish(context: Context, cards: List<TitleCard>, posterUrl: (TitleCard) -> String?) = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        try {
            val existing = mutableMapOf<String, Long>() // internalProviderId → row id
            resolver.query(TvContractCompat.WatchNextPrograms.CONTENT_URI, null, null, null, null)?.use { c: Cursor ->
                while (c.moveToNext()) {
                    val p = WatchNextProgram.fromCursor(c)
                    val id = p.internalProviderId ?: continue
                    // Only rows we own (other apps' Watch Next entries are not visible to us anyway on API 26+).
                    existing[id] = p.id
                }
            }
            val keep = mutableSetOf<String>()
            cards.forEach { card ->
                val key = "${card.kind}:${card.tmdbId}"
                keep += key
                val posMs = card.progress?.let { (it * 1000).toLong() } // fraction ×1000 as a pseudo-duration
                val b = WatchNextProgram.Builder()
                    .setType(if (card.kind == "tv") TvContractCompat.PreviewPrograms.TYPE_TV_EPISODE else TvContractCompat.PreviewPrograms.TYPE_MOVIE)
                    .setWatchNextType(TvContractCompat.WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE)
                    .setLastEngagementTimeUtcMillis(System.currentTimeMillis())
                    .setTitle(card.title)
                    .setDescription(card.overview ?: "")
                    .setPosterArtAspectRatio(TvContractCompat.PreviewPrograms.ASPECT_RATIO_2_3)
                    .setIntentUri(deepLink(card.kind, card.tmdbId))
                    .setInternalProviderId(key)
                posterUrl(card)?.let { b.setPosterArtUri(Uri.parse(it)) }
                if (posMs != null) { b.setLastPlaybackPositionMillis(posMs.toInt()); b.setDurationMillis(1000) }
                val values = b.build().toContentValues()
                val rowId = existing[key]
                if (rowId != null) {
                    resolver.update(TvContractCompat.buildWatchNextProgramUri(rowId), values, null, null)
                } else {
                    resolver.insert(TvContractCompat.WatchNextPrograms.CONTENT_URI, values)
                }
            }
            existing.filterKeys { it !in keep }.forEach { (_, rowId) ->
                resolver.delete(TvContractCompat.buildWatchNextProgramUri(rowId), null, null)
            }
            Log.i(TAG, "published ${cards.size} watch-next programs")
        } catch (e: Exception) {
            // No TV provider (emulator / non-Leanback device) or permission denied — not fatal.
            Log.w(TAG, "publish failed: ${e.message}")
        }
    }

    /** Parses `mixai://title/<kind>/<tmdbId>` from a launch intent. */
    fun parseDeepLink(intent: Intent?): Pair<String, Long>? {
        val u = intent?.data ?: return null
        if (u.scheme != "mixai" || u.host != "title") return null
        val seg = u.pathSegments
        if (seg.size < 2) return null
        val id = seg[1].toLongOrNull() ?: return null
        return seg[0] to id
    }
}
