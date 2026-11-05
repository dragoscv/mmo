package ro.mixai.app.ui.title

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.widget.Toast
import ro.mixai.app.R
import ro.mixai.tv.data.androidPackage
import ro.mixai.tv.data.androidUri
import ro.mixai.tv.data.generated.Offer

// Opens a streaming provider for one title on a PHONE (port of tv-android data/ProviderLauncher.kt).
// The server sends Android TV package ids; they are mapped to the phone apps. Order: link pinned to
// the phone package → launch the app → any handler (browser) → Play Store. Packages must be listed
// in the manifest `<queries>` for package visibility on API 30+.
object PhoneProviderLauncher {
    private const val TAG = "PhoneProviderLauncher"

    /** TV package → phone package (null = no phone app, use the browser). Unknown ids pass through. */
    private val TV_TO_PHONE: Map<String, String?> = mapOf(
        "com.netflix.ninja" to "com.netflix.mediaclient",
        "com.amazon.amazonvideo.livingroom" to "com.amazon.avod.thirdpartyclient",
        "com.apple.atve.androidtv.appletv" to "com.apple.atve.android.appletv",
        "com.google.android.youtube.tv" to "com.google.android.youtube",
        "net.cme.voyo.ro.tvapp" to null,
    )

    fun phonePackage(offer: Offer): String? {
        val tv = offer.launch.androidPackage ?: return null
        return if (TV_TO_PHONE.containsKey(tv)) TV_TO_PHONE[tv] else tv
    }

    fun isInstalled(context: Context, pkg: String?): Boolean =
        pkg != null && context.packageManager.getLaunchIntentForPackage(pkg) != null

    /** Best URL: exact link → provider android uri → provider web page → provider search. */
    fun targetUrl(offer: Offer): String? =
        offer.link?.takeIf { it.isNotBlank() }
            ?: offer.launch.androidUri?.takeIf { it.startsWith("http") }
            ?: offer.launch.web.takeIf { it.isNotBlank() }
            ?: offer.launch.search.takeIf { it.isNotBlank() }

    fun launch(context: Context, offer: Offer) {
        val url = targetUrl(offer)
        val pkg = phonePackage(offer)
        if (url == null && pkg == null) {
            Toast.makeText(context, context.getString(R.string.title_provider_no_link, offer.name), Toast.LENGTH_SHORT).show()
            return
        }
        val uri = url?.let(Uri::parse)
        if (pkg != null && uri != null && tryStart(context, Intent(Intent.ACTION_VIEW, uri).setPackage(pkg))) return
        if (pkg != null) {
            val launchIntent = context.packageManager.getLaunchIntentForPackage(pkg)
            if (launchIntent != null && tryStart(context, launchIntent)) return
        }
        if (uri != null && tryStart(context, Intent(Intent.ACTION_VIEW, uri))) return
        if (pkg != null) {
            Toast.makeText(context, context.getString(R.string.title_provider_install_hint, offer.name), Toast.LENGTH_SHORT).show()
            if (tryStart(context, Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg")))) return
            if (tryStart(context, Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$pkg")))) return
        }
        Toast.makeText(context, context.getString(R.string.title_provider_launch_failed, offer.name), Toast.LENGTH_LONG).show()
    }

    private fun tryStart(context: Context, intent: Intent): Boolean = try {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        Log.i(TAG, "started ${intent.`package` ?: "*"} -> ${intent.data}")
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (e: SecurityException) {
        Log.w(TAG, "start refused: ${e.message}")
        false
    }
}
