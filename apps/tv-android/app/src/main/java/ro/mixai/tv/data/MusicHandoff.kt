package ro.mixai.tv.data

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

// MixAI TV → MixAI Music handoff (D51/D55, WP17-45). When Music is installed on the TV, the Music
// rail / hub "navigate music" / Stats shortcut open it via the canonical `mixai-music://` set
// (same grammar as music-android MusicNavigator.parseLink, iOS MusicDeepLink, desktop links.rs);
// otherwise MixAI TV keeps its built-in player. Package + scheme are declared in `<queries>`.
object MusicHandoff {
    private const val TAG = "MusicHandoff"
    const val PACKAGE = "ro.mixai.music"
    const val SCHEME = "mixai-music"

    /** Canonical link: the current queue (ids + index) when something plays, else Music's home. */
    fun url(queueIds: List<String> = emptyList(), index: Int = 0): String {
        val ids = queueIds.filter { it.isNotBlank() && !it.contains(',') }.take(200)
        if (ids.isEmpty()) return "$SCHEME://home"
        val enc = ids.joinToString(",") { java.net.URLEncoder.encode(it, Charsets.UTF_8).replace("+", "%20") }
        return "$SCHEME://play?ids=$enc&index=${index.coerceIn(0, ids.lastIndex)}"
    }

    fun intent(url: String): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(PACKAGE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun isAvailable(context: Context): Boolean =
        runCatching { intent("$SCHEME://home").resolveActivity(context.packageManager) != null }.getOrDefault(false)

    /** Opens Music; false when it is not installed (caller falls back to the built-in player). */
    fun open(context: Context, url: String = url()): Boolean {
        if (!isAvailable(context)) return false
        return try { context.startActivity(intent(url)); true } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "open failed: ${e.message}"); false
        }
    }

    /**
     * Music entry point of MixAI TV: when Music is installed, the built-in queue (if any) moves to it
     * (`play?ids=&index=`) and the built-in player stops so the two never play over each other.
     * Returns false when Music is absent; the caller then shows the built-in Music screen.
     */
    fun openFromTv(context: Context, playback: MusicPlayback?): Boolean {
        val s = playback?.state?.value?.takeIf { it.isActive }
        val link = s?.let { url(it.queue.map { t -> t.id }, it.index) } ?: url()
        if (!open(context, link)) return false
        if (s != null) playback?.stop()
        return true
    }
}
