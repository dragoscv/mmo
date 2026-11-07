package ro.mixai.tv.cast

import java.net.URI
import java.util.Locale

// DLNA / UPnP MediaRenderer protocol helpers — pure, no Android or network APIs, so every function
// is testable with plain JUnit on the JVM (android.util.Xml is not available there, hence the
// regex/string parsing). Port of server/src/cast/dlna.ts, extended with RenderingControl,
// ConnectionManager, SetNextAVTransportURI, icons and UPnP fault parsing. Network layer: DlnaClient.

/** A UPnP MediaRenderer that exposes AVTransport. All URLs are absolute. */
data class DlnaRenderer(
    val udn: String,
    val name: String,
    val manufacturer: String?,
    val model: String?,
    val location: String,
    val avTransportUrl: String,
    val renderingControlUrl: String?,
    val connectionManagerUrl: String?,
    val iconUrl: String?,
    /** Exact serviceType strings found in the description (AVTransport:1 or :2, etc.). */
    val avTransportUrn: String = DlnaProtocol.AVTRANSPORT_URN,
    val renderingControlUrn: String = DlnaProtocol.RENDERING_CONTROL_URN,
    val connectionManagerUrn: String = DlnaProtocol.CONNECTION_MANAGER_URN,
)

data class DlnaPosition(val trackUri: String?, val relTimeMs: Long?, val durationMs: Long?)

/** state: PLAYING, PAUSED_PLAYBACK, STOPPED, TRANSITIONING, NO_MEDIA_PRESENT (renderer-reported). */
data class DlnaTransport(val state: String, val status: String?)

data class DlnaMeta(
    val title: String,
    val artist: String?,
    val album: String?,
    val albumArtUrl: String?,
    val mime: String,
    val durationMs: Long?,
)

class DlnaException(message: String, val upnpCode: Int? = null) : Exception(message)

object DlnaProtocol {
    const val SSDP_ADDR = "239.255.255.250"
    const val SSDP_PORT = 1900
    const val MEDIA_RENDERER_ST = "urn:schemas-upnp-org:device:MediaRenderer:1"
    const val AVTRANSPORT_URN = "urn:schemas-upnp-org:service:AVTransport:1"
    const val RENDERING_CONTROL_URN = "urn:schemas-upnp-org:service:RenderingControl:1"
    const val CONNECTION_MANAGER_URN = "urn:schemas-upnp-org:service:ConnectionManager:1"
    private const val AVTRANSPORT_PREFIX = "urn:schemas-upnp-org:service:AVTransport:"
    private const val RENDERING_CONTROL_PREFIX = "urn:schemas-upnp-org:service:RenderingControl:"
    private const val CONNECTION_MANAGER_PREFIX = "urn:schemas-upnp-org:service:ConnectionManager:"

    /** DLNA flags: streaming transfer, background transfer, connection stall, DLNA v1.5. */
    const val DLNA_AUDIO_EXTRA = "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000"

    /** M-SEARCH datagram for [st] (MX 2). */
    fun mSearch(st: String = MEDIA_RENDERER_ST): String =
        "M-SEARCH * HTTP/1.1\r\nHOST: $SSDP_ADDR:$SSDP_PORT\r\nMAN: \"ssdp:discover\"\r\n" +
            "MX: 2\r\nST: $st\r\n\r\n"

    private fun headers(lines: List<String>): Map<String, String> {
        val out = HashMap<String, String>()
        for (line in lines.drop(1)) {
            val idx = line.indexOf(':')
            if (idx <= 0) continue
            out[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
        }
        return out
    }

    /**
     * LOCATION of an SSDP search response (status 200) or of a NOTIFY ssdp:alive whose NT is a
     * MediaRenderer; null otherwise.
     */
    fun parseSsdpResponse(raw: String): String? {
        val lines = raw.split(Regex("\r?\n"))
        val status = lines.firstOrNull()?.trim().orEmpty()
        val h = headers(lines)
        val location = h["location"]?.takeIf { it.isNotBlank() } ?: return null
        return when {
            Regex("^HTTP/1\\.[01]\\s+200\\b", RegexOption.IGNORE_CASE).containsMatchIn(status) -> location
            status.startsWith("NOTIFY", ignoreCase = true) &&
                h["nts"].equals("ssdp:alive", ignoreCase = true) &&
                h["nt"].orEmpty().contains("device:MediaRenderer:", ignoreCase = true) -> location
            else -> null
        }
    }

    // ─── XML helpers ─────────────────────────────────────────────────────────────────────────────

    private val ENTITY = Regex("&(#x[0-9a-fA-F]+|#\\d+|amp|lt|gt|quot|apos);")

    /** Decodes the five predefined entities and numeric character references (single pass). */
    fun decodeXml(s: String): String = ENTITY.replace(s) { m ->
        when (val e = m.groupValues[1]) {
            "amp" -> "&"
            "lt" -> "<"
            "gt" -> ">"
            "quot" -> "\""
            "apos" -> "'"
            else -> {
                val cp = if (e.startsWith("#x") || e.startsWith("#X")) e.substring(2).toIntOrNull(16)
                else e.substring(1).toIntOrNull()
                if (cp != null && Character.isValidCodePoint(cp)) String(Character.toChars(cp)) else m.value
            }
        }
    }

    fun escapeXml(s: String): String {
        val sb = StringBuilder(s.length + 16)
        for (c in s) {
            when (c) {
                '&' -> sb.append("&amp;")
                '<' -> sb.append("&lt;")
                '>' -> sb.append("&gt;")
                '"' -> sb.append("&quot;")
                '\'' -> sb.append("&apos;")
                else -> sb.append(c)
            }
        }
        return sb.toString()
    }

    private fun tagRegex(tag: String) =
        Regex("<(?:[\\w.-]+:)?$tag(?:\\s[^>]*)?>([^<]*)</(?:[\\w.-]+:)?$tag\\s*>", RegexOption.IGNORE_CASE)

    private fun xmlText(xml: String, tag: String): String? =
        tagRegex(tag).find(xml)?.groupValues?.get(1)?.trim()?.let(::decodeXml)?.takeIf { it.isNotEmpty() }

    /** Last occurrence of `<tag>` that starts before [before]. */
    private fun lastTextBefore(xml: String, tag: String, before: Int): String? =
        tagRegex(tag).findAll(xml).lastOrNull { it.range.first < before }
            ?.groupValues?.get(1)?.trim()?.let(::decodeXml)?.takeIf { it.isNotEmpty() }

    private fun blocks(xml: String, tag: String): List<Pair<Int, String>> =
        Regex("<(?:[\\w.-]+:)?$tag(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?$tag\\s*>", RegexOption.IGNORE_CASE)
            .findAll(xml).map { it.range.first to it.groupValues[1] }.toList()

    private fun resolve(base: String, path: String): String? = try {
        val u = URI(base.trim()).resolve(URI(path.trim().replace(" ", "%20")))
        if (u.isAbsolute && u.host != null) u.toString() else null
    } catch (_: Exception) {
        null
    }

    private class Service(val pos: Int, val type: String, val control: String?)

    /**
     * Parses a UPnP device description. Returns null when no device exposes AVTransport. URLs are
     * resolved against URLBase when present, else [location]. The device fields (UDN, name, …)
     * come from the device that owns the AVTransport service, so embedded renderers work too.
     */
    fun parseDeviceDescription(xml: String, location: String): DlnaRenderer? {
        val services = blocks(xml, "service").mapNotNull { (pos, body) ->
            val type = xmlText(body, "serviceType") ?: return@mapNotNull null
            Service(pos, type, xmlText(body, "controlURL"))
        }
        val av = services.firstOrNull { it.type.startsWith(AVTRANSPORT_PREFIX, ignoreCase = true) } ?: return null
        val base = xmlText(xml, "URLBase") ?: location
        val avUrl = av.control?.let { resolve(base, it) } ?: return null
        val udn = lastTextBefore(xml, "UDN", av.pos)?.replace(Regex("^uuid:", RegexOption.IGNORE_CASE), "")
            ?.takeIf { it.isNotBlank() } ?: return null
        val rc = services.firstOrNull { it.type.startsWith(RENDERING_CONTROL_PREFIX, ignoreCase = true) }
        val cm = services.firstOrNull { it.type.startsWith(CONNECTION_MANAGER_PREFIX, ignoreCase = true) }
        val icon = blocks(xml, "icon").mapNotNull { (_, body) ->
            val mime = xmlText(body, "mimetype")?.lowercase() ?: return@mapNotNull null
            if (mime != "image/png" && mime != "image/jpeg" && mime != "image/jpg") return@mapNotNull null
            val url = xmlText(body, "url")?.let { resolve(base, it) } ?: return@mapNotNull null
            val area = (xmlText(body, "width")?.toLongOrNull() ?: 0L) * (xmlText(body, "height")?.toLongOrNull() ?: 0L)
            area to url
        }.maxByOrNull { it.first }?.second
        return DlnaRenderer(
            udn = udn,
            name = lastTextBefore(xml, "friendlyName", av.pos) ?: udn,
            manufacturer = lastTextBefore(xml, "manufacturer", av.pos),
            model = lastTextBefore(xml, "modelName", av.pos),
            location = location,
            avTransportUrl = avUrl,
            renderingControlUrl = rc?.control?.let { resolve(base, it) },
            connectionManagerUrl = cm?.control?.let { resolve(base, it) },
            iconUrl = icon,
            avTransportUrn = av.type,
            renderingControlUrn = rc?.type ?: RENDERING_CONTROL_URN,
            connectionManagerUrn = cm?.type ?: CONNECTION_MANAGER_URN,
        )
    }

    // ─── SOAP ────────────────────────────────────────────────────────────────────────────────────

    /**
     * SOAP 1.1 envelope for [action] on [serviceUrn]. `InstanceID=0` always comes first (unless the
     * caller passes it); RenderingControl actions need `Channel=Master` in [args].
     */
    fun soapEnvelope(serviceUrn: String, action: String, args: List<Pair<String, String>>): String {
        val sb = StringBuilder()
        sb.append("<?xml version=\"1.0\" encoding=\"utf-8\"?>")
        sb.append("<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" ")
        sb.append("s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">")
        sb.append("<s:Body><u:").append(action).append(" xmlns:u=\"").append(escapeXml(serviceUrn)).append("\">")
        if (args.none { it.first == "InstanceID" }) sb.append("<InstanceID>0</InstanceID>")
        for ((k, v) in args) sb.append('<').append(k).append('>').append(escapeXml(v)).append("</").append(k).append('>')
        sb.append("</u:").append(action).append("></s:Body></s:Envelope>")
        return sb.toString()
    }

    private val LEAF = Regex("<(?:[\\w.-]+:)?([A-Za-z_][\\w.-]*)(?:\\s[^>]*)?>([^<]*)</(?:[\\w.-]+:)?\\1\\s*>")
    private val EMPTY_LEAF = Regex("<(?:[\\w.-]+:)?([A-Za-z_][\\w.-]*)(?:\\s[^>]*)?/>")

    /** Leaf elements (namespace prefix dropped) → decoded text, e.g. TrackMetaData as a DIDL string. */
    fun parseSoapResponse(xml: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (m in EMPTY_LEAF.findAll(xml)) out.putIfAbsent(m.groupValues[1], "")
        for (m in LEAF.findAll(xml)) out[m.groupValues[1]] = decodeXml(m.groupValues[2].trim())
        return out
    }

    /** UPnPError errorCode, or null when [xml] is not a fault. */
    fun soapFaultCode(xml: String): Int? =
        if (!xml.contains("Fault", ignoreCase = true) && !xml.contains("UPnPError")) null
        else parseSoapResponse(xml)["errorCode"]?.trim()?.toIntOrNull()

    /** "701: Transition not available" from a UPnPError fault (faultstring fallback); null otherwise. */
    fun soapFault(xml: String): String? {
        if (!xml.contains("Fault", ignoreCase = true) && !xml.contains("UPnPError")) return null
        val m = parseSoapResponse(xml)
        val code = m["errorCode"]?.trim()?.takeIf { it.isNotEmpty() }
        val desc = m["errorDescription"]?.trim()?.takeIf { it.isNotEmpty() }
        return when {
            code != null && desc != null -> "$code: $desc"
            code != null -> code
            desc != null -> desc
            else -> m["faultstring"]?.trim()?.takeIf { it.isNotEmpty() }
        }
    }

    // ─── DIDL-Lite ───────────────────────────────────────────────────────────────────────────────

    /** DIDL-Lite musicTrack document for SetAVTransportURI / SetNextAVTransportURI metadata. */
    fun didlLite(url: String, meta: DlnaMeta): String {
        val sb = StringBuilder()
        sb.append("<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" ")
        sb.append("xmlns:dc=\"http://purl.org/dc/elements/1.1/\" ")
        sb.append("xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" ")
        sb.append("xmlns:dlna=\"urn:schemas-dlna-org:metadata-1-0/\">")
        sb.append("<item id=\"0\" parentID=\"-1\" restricted=\"1\">")
        sb.append("<dc:title>").append(escapeXml(meta.title)).append("</dc:title>")
        sb.append("<upnp:class>object.item.audioItem.musicTrack</upnp:class>")
        meta.artist?.takeIf { it.isNotBlank() }?.let {
            sb.append("<upnp:artist>").append(escapeXml(it)).append("</upnp:artist>")
            sb.append("<dc:creator>").append(escapeXml(it)).append("</dc:creator>")
        }
        meta.album?.takeIf { it.isNotBlank() }?.let { sb.append("<upnp:album>").append(escapeXml(it)).append("</upnp:album>") }
        meta.albumArtUrl?.takeIf { it.isNotBlank() }?.let {
            sb.append("<upnp:albumArtURI>").append(escapeXml(it)).append("</upnp:albumArtURI>")
        }
        sb.append("<res protocolInfo=\"http-get:*:").append(escapeXml(meta.mime)).append(':').append(DLNA_AUDIO_EXTRA).append('"')
        meta.durationMs?.takeIf { it > 0 }?.let { sb.append(" duration=\"").append(formatTime(it)).append(".000\"") }
        sb.append('>').append(escapeXml(url)).append("</res>")
        sb.append("</item></DIDL-Lite>")
        return sb.toString()
    }

    // ─── Time ────────────────────────────────────────────────────────────────────────────────────

    private val TIME = Regex("^\\+?(\\d+):(\\d{1,2}):(\\d{1,2})(?:\\.(\\d+))?$")

    /** "H:MM:SS" or "H:MM:SS.fff" → ms; null for NOT_IMPLEMENTED, empty or garbage. */
    fun parseTime(s: String?): Long? {
        val m = TIME.find(s?.trim() ?: return null) ?: return null
        val (h, mm, ss, frac) = m.destructured
        val min = mm.toLong()
        val sec = ss.toLong()
        if (min > 59 || sec > 59) return null
        val ms = if (frac.isEmpty()) 0L else frac.padEnd(3, '0').substring(0, 3).toLong()
        return ((h.toLong() * 60 + min) * 60 + sec) * 1000 + ms
    }

    /** ms → "H:MM:SS" (floored, negatives clamp to 0). */
    fun formatTime(ms: Long): String {
        val s = (ms.coerceAtLeast(0)) / 1000
        return String.format(Locale.ROOT, "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
    }

    /**
     * GetProtocolInfo `Sink` CSV → lowercased mimes of the `http-get` entries. A literal `*` mime
     * (accept anything) is kept so callers can treat it as a wildcard.
     */
    fun parseSinkProtocolInfo(csv: String): Set<String> {
        val out = LinkedHashSet<String>()
        for (entry in csv.split(',')) {
            val parts = entry.trim().split(':')
            if (parts.size < 3 || !parts[0].trim().equals("http-get", ignoreCase = true)) continue
            val mime = parts[2].trim().lowercase()
            if (mime.isNotEmpty()) out.add(mime)
        }
        return out
    }
}
