package ro.mixai.tv.data

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.util.Log
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.util.concurrent.atomic.AtomicBoolean

/** One MMO Server seen on the LAN via mDNS (`_mmo-companion._tcp`). */
data class DiscoveredServer(
    val host: String,
    val port: Int,
    /** TXT `name` if published, else the mDNS instance name, else the host. */
    val name: String,
    val version: String? = null,
    val serviceName: String = "",
) {
    val baseUrl: String get() = "http://$host:$port"
    val key: String get() = "$host:$port"
}

/**
 * Discovers `_mmo-companion._tcp` with `NsdManager`, resolving each service to
 * host/port/TXT. Holds a `WifiManager.MulticastLock` while active — some
 * Android TV devices drop multicast otherwise and never see mDNS answers.
 * Emits a snapshot of the current server list every time it changes.
 */
fun discoverServers(context: Context): Flow<List<DiscoveredServer>> = callbackFlow {
    val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    val lock = try {
        wifi?.createMulticastLock("mixai-tv-discovery")?.apply { setReferenceCounted(false); acquire() }
    } catch (e: Exception) {
        Log.w(TAG, "multicast lock failed: ${e.message}"); null
    }

    val found = linkedMapOf<String, DiscoveredServer>()
    val resolving = AtomicBoolean(false)
    val pending = ArrayDeque<NsdServiceInfo>()

    fun publish() { trySend(found.values.toList()) }

    // NsdManager (API < 34) allows one resolve at a time → serialise them.
    fun resolveNext() {
        if (resolving.get()) return
        val info = pending.removeFirstOrNull() ?: return
        resolving.set(true)
        @Suppress("DEPRECATION")
        nsd.resolveService(info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "resolve failed ${serviceInfo.serviceName}: $errorCode")
                resolving.set(false); resolveNext()
            }
            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                val host = serviceInfo.host?.hostAddress
                if (host != null && !host.contains(':')) { // IPv4 only; the server binds v4
                    val txt = serviceInfo.attributes ?: emptyMap()
                    fun t(k: String) = txt[k]?.let { String(it, Charsets.UTF_8) }?.takeIf { it.isNotBlank() }
                    val s = DiscoveredServer(
                        host = host,
                        port = serviceInfo.port,
                        name = t("name") ?: serviceInfo.serviceName.substringAfter('(').substringBefore(')').ifBlank { host },
                        version = t("version"),
                        serviceName = serviceInfo.serviceName,
                    )
                    found[s.key] = s
                    publish()
                }
                resolving.set(false); resolveNext()
            }
        })
    }

    val listener = object : NsdManager.DiscoveryListener {
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { Log.w(TAG, "start failed $errorCode"); close() }
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        override fun onDiscoveryStarted(serviceType: String) {}
        override fun onDiscoveryStopped(serviceType: String) {}
        override fun onServiceFound(serviceInfo: NsdServiceInfo) {
            if (!serviceInfo.serviceType.contains(SERVICE_TYPE)) return
            pending.addLast(serviceInfo); resolveNext()
        }
        override fun onServiceLost(serviceInfo: NsdServiceInfo) {
            val removed = found.entries.removeIf { it.value.serviceName == serviceInfo.serviceName }
            if (removed) publish()
        }
    }

    publish()
    nsd.discoverServices("$SERVICE_TYPE.", NsdManager.PROTOCOL_DNS_SD, listener)

    awaitClose {
        try { nsd.stopServiceDiscovery(listener) } catch (_: Exception) {}
        try { lock?.release() } catch (_: Exception) {}
    }
}

private const val TAG = "MixaiDiscovery"
private const val SERVICE_TYPE = "_mmo-companion._tcp"
