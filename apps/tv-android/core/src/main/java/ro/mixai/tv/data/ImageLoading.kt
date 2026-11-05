package ro.mixai.tv.data

import android.app.ActivityManager
import android.content.Context
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.ImageRequest
import coil3.request.allowRgb565
import coil3.request.crossfade
import okio.Path.Companion.toOkioPath
import java.io.File

// Coil singleton tuned for TV (WP16-28): memory cache 20 % of the app heap (15 % on low-RAM
// devices + RGB_565), 256 MB disk cache in `cacheDir/coil`, 200 ms crossfade, shared OkHttp pool.
fun newMixaiImageLoader(context: Context): ImageLoader {
    val lowRam = isLowRam(context)
    return ImageLoader.Builder(context)
        .components { add(OkHttpNetworkFetcherFactory(callFactory = { Http.client })) }
        .memoryCache { MemoryCache.Builder().maxSizePercent(context, if (lowRam) 0.15 else 0.20).build() }
        .diskCache { DiskCache.Builder().directory(File(context.cacheDir, "coil").toOkioPath()).maxSizeBytes(256L * 1024 * 1024).build() }
        .crossfade(200)
        .allowRgb565(lowRam)
        .build()
}

fun isLowRam(context: Context): Boolean =
    (context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager)?.isLowRamDevice == true

/** Warm the caches for the next screen (sized requests, so the decoded bitmap is reusable). */
fun prefetch(context: Context, urls: List<String?>, widthPx: Int, heightPx: Int) {
    val loader = SingletonImageLoader.get(context)
    urls.asSequence().filterNotNull().filter { it.isNotBlank() }.distinct().forEach { u ->
        loader.enqueue(ImageRequest.Builder(context).data(u).size(widthPx, heightPx).build())
    }
}

/** TMDB image sizes the server proxy accepts (`/video/tmdb-image/{size}/{path}`). */
object TmdbSize {
    private val POSTER = listOf(185 to "w185", 342 to "w342", 500 to "w500", 780 to "w780")
    private val BACKDROP = listOf(300 to "w300", 780 to "w780", 1280 to "w1280")

    /** Smallest poster size ≥ [targetPx] wide (w780 max). */
    fun poster(targetPx: Int): String = POSTER.firstOrNull { it.first >= targetPx }?.second ?: "w780"

    /** Smallest backdrop/still size ≥ [targetPx] wide (w1280 max). */
    fun backdrop(targetPx: Int): String = BACKDROP.firstOrNull { it.first >= targetPx }?.second ?: "w1280"

    /** Generic pick across w185/w342/w500/w780/w1280. */
    fun forWidth(targetPx: Int): String = when {
        targetPx <= 185 -> "w185"
        targetPx <= 342 -> "w342"
        targetPx <= 500 -> "w500"
        targetPx <= 780 -> "w780"
        else -> "w1280"
    }
}
