package ro.mixai.app.ui.player

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/** Current network as the data saver sees it. */
enum class NetKind { None, Unmetered, Metered }

fun currentNet(context: Context): NetKind {
    val cm = context.getSystemService(ConnectivityManager::class.java) ?: return NetKind.None
    val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return NetKind.None
    if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return NetKind.None
    return if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) NetKind.Unmetered else NetKind.Metered
}

/** Data saver decision (pure): ask before streaming the original on a metered network unless allowed or offline copy. */
fun shouldAskCellular(net: NetKind, dataSaver: Boolean, titleAllowed: Boolean, hasOfflineCopy: Boolean): Boolean =
    net == NetKind.Metered && dataSaver && !titleAllowed && !hasOfflineCopy

/** Per-title key for the cellular override. */
fun cellularKey(kind: String?, tmdbId: Long?, fileId: String): String =
    if (kind != null && tmdbId != null) "$kind:$tmdbId" else "file:$fileId"
