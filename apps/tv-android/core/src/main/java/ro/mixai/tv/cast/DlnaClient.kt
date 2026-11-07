package ro.mixai.tv.cast

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

/**
 * On-device DLNA/UPnP MediaRenderer control point: SSDP discovery + SOAP AVTransport,
 * RenderingControl and ConnectionManager calls. Every call runs on [Dispatchers.IO]; failures are
 * [DlnaException] (with the UPnP error code when the renderer returned a fault) or IOException.
 * Protocol details live in [DlnaProtocol].
 */
class DlnaClient(http: OkHttpClient) {
    private val soapHttp = http.newBuilder()
        .callTimeout(SOAP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .connectTimeout(SOAP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(SOAP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .build()
    private val describeHttp = http.newBuilder()
        .callTimeout(DESCRIBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .connectTimeout(DESCRIBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(DESCRIBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .build()

    // ─── Discovery ───────────────────────────────────────────────────────────────────────────────

    /** SSDP search for MediaRenderers during [windowMs]; deduped by UDN, sorted by name. */
    suspend fun discover(context: Context, windowMs: Long = 3000): List<DlnaRenderer> = withContext(Dispatchers.IO) {
        val locations = ssdpSearch(context.applicationContext, windowMs)
        val renderers = coroutineScope {
            locations.map { loc -> async { describe(loc) } }.awaitAll()
        }.filterNotNull()
        renderers.associateBy { it.udn }.values.sortedBy { it.name.lowercase() }
    }

    /** Fetches and parses one description document; null on any failure or no AVTransport. */
    suspend fun describe(location: String): DlnaRenderer? = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url(location).get().build()
            describeHttp.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return@use null
                DlnaProtocol.parseDeviceDescription(res.body.string(), location)
            }
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun ssdpSearch(context: Context, windowMs: Long): Set<String> {
        val locations = LinkedHashSet<String>()
        val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = wifi?.createMulticastLock(MULTICAST_LOCK_TAG)?.apply { setReferenceCounted(false) }
        try {
            try { lock?.acquire() } catch (_: SecurityException) { /* CHANGE_WIFI_MULTICAST_STATE missing: unicast replies still arrive */ }
            MulticastSocket(null as InetSocketAddress?).use { sock ->
                sock.reuseAddress = true
                sock.bind(InetSocketAddress(0))
                sock.timeToLive = 4
                val group = InetAddress.getByName(DlnaProtocol.SSDP_ADDR)
                val payload = DlnaProtocol.mSearch(DlnaProtocol.MEDIA_RENDERER_ST).toByteArray(Charsets.US_ASCII)
                val send = { sock.send(DatagramPacket(payload, payload.size, group, DlnaProtocol.SSDP_PORT)) }
                val buf = ByteArray(8192)
                val start = System.currentTimeMillis()
                val deadline = start + windowMs
                var sentSecond = false
                try { send() } catch (_: IOException) { /* network down: second send / window still run */ }
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val now = System.currentTimeMillis()
                    if (now >= deadline) break
                    // Wi-Fi multicast often drops the first datagram: resend once after 400 ms.
                    if (!sentSecond && now - start >= RESEND_AFTER_MS) {
                        sentSecond = true
                        try { send() } catch (_: IOException) { }
                    }
                    val wait = if (sentSecond) deadline - now else minOf(deadline - now, start + RESEND_AFTER_MS - now)
                    sock.soTimeout = wait.coerceIn(1, Int.MAX_VALUE.toLong()).toInt()
                    val packet = DatagramPacket(buf, buf.size)
                    try {
                        sock.receive(packet)
                    } catch (_: SocketTimeoutException) {
                        continue
                    }
                    val raw = String(packet.data, packet.offset, packet.length, Charsets.UTF_8)
                    DlnaProtocol.parseSsdpResponse(raw)?.let(locations::add)
                }
            }
        } catch (_: IOException) {
            // Socket could not be created (no network): return what was collected.
        } finally {
            try { if (lock?.isHeld == true) lock.release() } catch (_: RuntimeException) { }
        }
        return locations
    }

    // ─── AVTransport ─────────────────────────────────────────────────────────────────────────────

    suspend fun setUri(r: DlnaRenderer, url: String, meta: DlnaMeta) {
        av(r, "SetAVTransportURI", listOf("CurrentURI" to url, "CurrentURIMetaData" to DlnaProtocol.didlLite(url, meta)))
    }

    /** Gapless pre-queue. false when the renderer does not implement SetNextAVTransportURI. */
    suspend fun setNextUri(r: DlnaRenderer, url: String, meta: DlnaMeta): Boolean = try {
        av(r, "SetNextAVTransportURI", listOf("NextURI" to url, "NextURIMetaData" to DlnaProtocol.didlLite(url, meta)))
        true
    } catch (e: DlnaException) {
        if (e.upnpCode == 401 || e.upnpCode == 602) false else throw e
    }

    suspend fun play(r: DlnaRenderer) { av(r, "Play", listOf("Speed" to "1")) }
    suspend fun pause(r: DlnaRenderer) { av(r, "Pause") }
    suspend fun stop(r: DlnaRenderer) { av(r, "Stop") }

    suspend fun seek(r: DlnaRenderer, positionMs: Long) {
        av(r, "Seek", listOf("Unit" to "REL_TIME", "Target" to DlnaProtocol.formatTime(positionMs)))
    }

    suspend fun position(r: DlnaRenderer): DlnaPosition {
        val m = av(r, "GetPositionInfo")
        return DlnaPosition(
            trackUri = m["TrackURI"]?.takeIf { it.isNotBlank() && it != "NOT_IMPLEMENTED" },
            relTimeMs = DlnaProtocol.parseTime(m["RelTime"]),
            durationMs = DlnaProtocol.parseTime(m["TrackDuration"])?.takeIf { it > 0 },
        )
    }

    suspend fun transport(r: DlnaRenderer): DlnaTransport {
        val m = av(r, "GetTransportInfo")
        return DlnaTransport(
            state = m["CurrentTransportState"]?.trim()?.uppercase()?.takeIf { it.isNotEmpty() } ?: "STOPPED",
            status = m["CurrentTransportStatus"]?.trim()?.takeIf { it.isNotEmpty() },
        )
    }

    // ─── RenderingControl ────────────────────────────────────────────────────────────────────────

    suspend fun volume(r: DlnaRenderer): Int? {
        val url = r.renderingControlUrl ?: return null
        val m = soap(url, r.renderingControlUrn, "GetVolume", listOf("Channel" to "Master"))
        return m["CurrentVolume"]?.trim()?.toIntOrNull()?.coerceIn(0, 100)
    }

    suspend fun setVolume(r: DlnaRenderer, level: Int) {
        val url = r.renderingControlUrl ?: throw DlnaException("Renderer has no RenderingControl")
        soap(url, r.renderingControlUrn, "SetVolume",
            listOf("Channel" to "Master", "DesiredVolume" to level.coerceIn(0, 100).toString()))
    }

    suspend fun setMute(r: DlnaRenderer, muted: Boolean) {
        val url = r.renderingControlUrl ?: throw DlnaException("Renderer has no RenderingControl")
        soap(url, r.renderingControlUrn, "SetMute",
            listOf("Channel" to "Master", "DesiredMute" to if (muted) "1" else "0"))
    }

    // ─── ConnectionManager ───────────────────────────────────────────────────────────────────────

    /** Lowercased sink mimes from GetProtocolInfo; empty when unknown or the call fails. */
    suspend fun sinkMimes(r: DlnaRenderer): Set<String> {
        val url = r.connectionManagerUrl ?: return emptySet()
        return try {
            val m = soap(url, r.connectionManagerUrn, "GetProtocolInfo", emptyList(), instanceId = false)
            DlnaProtocol.parseSinkProtocolInfo(m["Sink"].orEmpty())
        } catch (_: DlnaException) {
            emptySet()
        } catch (_: IOException) {
            emptySet()
        }
    }

    // ─── SOAP transport ──────────────────────────────────────────────────────────────────────────

    private suspend fun av(r: DlnaRenderer, action: String, args: List<Pair<String, String>> = emptyList()) =
        soap(r.avTransportUrl, r.avTransportUrn, action, args)

    /**
     * POSTs one SOAP action. [instanceId] false omits InstanceID (ConnectionManager actions take
     * none). Non-2xx → [DlnaException] carrying the UPnP fault description and code.
     */
    suspend fun soap(
        url: String,
        serviceUrn: String,
        action: String,
        args: List<Pair<String, String>>,
        instanceId: Boolean = true,
    ): Map<String, String> = withContext(Dispatchers.IO) {
        val envelope = if (instanceId) DlnaProtocol.soapEnvelope(serviceUrn, action, args)
        else DlnaProtocol.soapEnvelope(serviceUrn, action, args).replaceFirst("<InstanceID>0</InstanceID>", "")
        val req = Request.Builder()
            .url(url)
            .header("SOAPACTION", "\"$serviceUrn#$action\"")
            .post(envelope.toRequestBody(SOAP_MEDIA_TYPE))
            .build()
        soapHttp.newCall(req).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) {
                val fault = DlnaProtocol.soapFault(text)
                throw DlnaException(
                    "DLNA $action failed (HTTP ${res.code})" + (fault?.let { ": $it" } ?: ""),
                    DlnaProtocol.soapFaultCode(text),
                )
            }
            DlnaProtocol.parseSoapResponse(text)
        }
    }

    private companion object {
        const val SOAP_TIMEOUT_MS = 8_000L
        const val DESCRIBE_TIMEOUT_MS = 3_000L
        const val RESEND_AFTER_MS = 400L
        const val MULTICAST_LOCK_TAG = "mixai-dlna"
        val SOAP_MEDIA_TYPE = "text/xml; charset=\"utf-8\"".toMediaType()
    }
}
