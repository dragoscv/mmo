package ro.mixai.music.wear

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log

/**
 * Asks Wear OS for a high-bandwidth (Wi-Fi) network while downloads run: by default a watch routes
 * traffic over the phone's Bluetooth proxy, far too slow for audio files. Released when idle so the
 * watch can turn Wi-Fi off again (battery).
 */
class WearNetwork(context: Context) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private var callback: ConnectivityManager.NetworkCallback? = null

    @Synchronized
    fun request() {
        if (callback != null || cm == null) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // Bind the process so DownloadManager's HTTP uses Wi-Fi instead of the BT proxy.
                cm.bindProcessToNetwork(network)
                Log.i(TAG, "wifi available for downloads")
            }
            override fun onLost(network: Network) { cm.bindProcessToNetwork(null) }
        }
        val req = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()
        runCatching { cm.requestNetwork(req, cb) }.onSuccess { callback = cb }.onFailure { Log.w(TAG, "wifi request: ${it.message}") }
    }

    @Synchronized
    fun release() {
        val cb = callback ?: return
        callback = null
        runCatching { cm?.bindProcessToNetwork(null); cm?.unregisterNetworkCallback(cb) }
    }

    private companion object { const val TAG = "WearNetwork" }
}
