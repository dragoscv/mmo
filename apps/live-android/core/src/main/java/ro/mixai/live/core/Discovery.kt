package ro.mixai.live.core

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** An engine announced on the LAN (`_mixai-live._tcp`, TXT v=1,name,osc). Pairing still needs the QR token. */
data class DiscoveredEngine(val name: String, val host: String, val port: Int, val oscPort: Int?, val protocol: Int) {
    val key: String get() = "$host:$port"
}

/**
 * mDNS browse with NsdManager. Holds a Wi-Fi MulticastLock while collected (many phones drop multicast otherwise).
 * Emits the full current list on every change.
 */
class Discovery(context: Context) {
    private val app = context.applicationContext
    private val nsd = app.getSystemService(Context.NSD_SERVICE) as NsdManager

    fun engines(): Flow<List<DiscoveredEngine>> = callbackFlow {
        val wifi = app.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = wifi?.createMulticastLock("mixai-live-mdns")?.apply { setReferenceCounted(false); runCatching { acquire() } }
        val found = ConcurrentHashMap<String, DiscoveredEngine>()
        val exec = Executors.newSingleThreadExecutor()
        val callbacks = ConcurrentHashMap<String, NsdManager.ServiceInfoCallback>()
        fun publish() { trySend(found.values.sortedBy { it.name.lowercase() }) }

        fun accept(info: NsdServiceInfo) {
            val addr = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses.firstOrNull() else @Suppress("DEPRECATION") info.host
            val host = addr?.hostAddress?.substringBefore('%') ?: return
            val txt = info.attributes.mapValues { (_, v) -> v?.toString(Charsets.UTF_8) }
            val protocol = txt["v"]?.toIntOrNull() ?: 1
            val name = txt["name"]?.takeIf { it.isNotBlank() } ?: info.serviceName
            found[info.serviceName] = DiscoveredEngine(name, host, info.port, txt["osc"]?.toIntOrNull(), protocol)
            publish()
        }

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { Log.w(TAG, "start failed $errorCode") }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onServiceFound(info: NsdServiceInfo) {
                if (Build.VERSION.SDK_INT >= 34) {
                    val cb = object : NsdManager.ServiceInfoCallback {
                        override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = Unit
                        override fun onServiceUpdated(serviceInfo: NsdServiceInfo) = accept(serviceInfo)
                        override fun onServiceLost() { found.remove(info.serviceName); publish() }
                        override fun onServiceInfoCallbackUnregistered() = Unit
                    }
                    callbacks.put(info.serviceName, cb)?.let { runCatching { nsd.unregisterServiceInfoCallback(it) } }
                    runCatching { nsd.registerServiceInfoCallback(info, exec, cb) }
                } else {
                    @Suppress("DEPRECATION")
                    nsd.resolveService(info, object : NsdManager.ResolveListener {
                        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
                        override fun onServiceResolved(serviceInfo: NsdServiceInfo) = accept(serviceInfo)
                    })
                }
            }
            override fun onServiceLost(info: NsdServiceInfo) {
                found.remove(info.serviceName)
                val cb = callbacks.remove(info.serviceName)
                if (cb != null && Build.VERSION.SDK_INT >= 34) runCatching { nsd.unregisterServiceInfoCallback(cb) }
                publish()
            }
        }
        runCatching { nsd.discoverServices(MDNS_SERVICE, NsdManager.PROTOCOL_DNS_SD, listener) }
            .onFailure { Log.w(TAG, "discover: ${it.message}") }
        publish()
        awaitClose {
            runCatching { nsd.stopServiceDiscovery(listener) }
            if (Build.VERSION.SDK_INT >= 34) callbacks.values.forEach { runCatching { nsd.unregisterServiceInfoCallback(it) } }
            exec.shutdown()
            runCatching { lock?.release() }
        }
    }

    private companion object {
        const val TAG = "LiveDiscovery"
    }
}
