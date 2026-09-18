package ro.mixai.tv.data

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.widget.Toast
import ro.mixai.tv.R
import ro.mixai.tv.data.generated.Offer

// Opens a streaming provider for one title (WP12-01). Order: exact deep link / provider search URL
// pinned to the provider's Android TV package → any handler for the URL (browser) → Play Store
// page for the package. Packages must be declared in `<queries>` (AndroidManifest.xml) for
// `setPackage` + `getLaunchIntentForPackage` to see them on API 30+.
object ProviderLauncher {
    private const val TAG = "ProviderLauncher"

    /** Registry packages (mirrors `server/src/media/providers.ts`); keep in sync with the manifest `<queries>`. */
    val KNOWN_PACKAGES = listOf(
        "com.netflix.ninja", "com.disney.disneyplus", "com.wbd.stream", "com.amazon.amazonvideo.livingroom",
        "com.apple.atve.androidtv.appletv", "com.google.android.youtube.tv", "com.skyshowtime.skyshowtime.google",
        "net.cme.voyo.ro.tvapp", "ro.antenaplay.app", "com.google.android.videos",
    )

    fun isInstalled(context: Context, pkg: String?): Boolean =
        pkg != null && context.packageManager.getLaunchIntentForPackage(pkg) != null

    /** Best URL to open for this offer: MOTN exact link → provider `android.uri` → provider web page. */
    fun targetUrl(offer: Offer): String? =
        offer.link?.takeIf { it.isNotBlank() } ?: offer.launch.androidUri ?: offer.launch.web.takeIf { it.isNotBlank() } ?: offer.launch.search.takeIf { it.isNotBlank() }

    fun launch(context: Context, offer: Offer) {
        val url = targetUrl(offer)
        val pkg = offer.launch.androidPackage
        if (url == null && pkg == null) {
            Toast.makeText(context, context.getString(R.string.provider_no_link, offer.name), Toast.LENGTH_SHORT).show()
            return
        }
        val uri = url?.let(Uri::parse)
        // 1) pinned to the provider app
        if (pkg != null && uri != null && tryStart(context, Intent(Intent.ACTION_VIEW, uri).setPackage(pkg))) return
        // 1b) app installed but it declares no http(s) intent filter (verified on Google TV:
        //     `resolve-activity -p com.netflix.ninja` → "No activity found"). Open the app itself
        //     rather than dumping the user in a browser.
        if (pkg != null) {
            val launchIntent = context.packageManager.getLaunchIntentForPackage(pkg)
            if (launchIntent != null && tryStart(context, launchIntent)) return
        }
        // 2) app not installed → any handler (browser or another app)
        if (uri != null && tryStart(context, Intent(Intent.ACTION_VIEW, uri))) return
        // 3) Play Store fallback
        if (pkg != null) {
            Toast.makeText(context, context.getString(R.string.provider_install_hint, offer.name), Toast.LENGTH_SHORT).show()
            if (tryStart(context, Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg")))) return
            if (tryStart(context, Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$pkg")))) return
        }
        Toast.makeText(context, context.getString(R.string.provider_launch_failed, offer.name), Toast.LENGTH_LONG).show()
    }

    private fun tryStart(context: Context, intent: Intent): Boolean = try {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        Log.i(TAG, "started ${intent.`package` ?: "*"} → ${intent.data}")
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (e: SecurityException) {
        Log.w(TAG, "start refused: ${e.message}")
        false
    }
}
