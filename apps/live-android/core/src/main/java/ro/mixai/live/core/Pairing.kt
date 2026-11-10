package ro.mixai.live.core

import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URLDecoder

/** An engine the user paired with (QR / link / manual). Stored in DataStore and sent to the watch as JSON. */
@Serializable
data class PairedEngine(
    val name: String = "MixAI Live",
    val host: String,
    val port: Int = DEFAULT_PORT,
    val token: String,
    /** Role announced by the engine in `hello` (the token decides it). */
    val role: Role = Role.VIEWER,
    val lastUsedMillis: Long = 0,
) {
    val key: String get() = "$host:$port"

    private val hostPart: String get() = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
    val httpBase: String get() = "http://$hostPart:$port"

    fun wsUrl(clientId: String): String = "ws://$hostPart:$port/ws?t=$token&c=$clientId"

    fun toJson(): String = LiveJson.encodeToString(serializer(), this)

    companion object {
        fun fromJson(s: String): PairedEngine? = runCatching { LiveJson.decodeFromString(serializer(), s) }.getOrNull()
    }
}

object Pairing {
    private val TOKEN = Regex("^[0-9a-fA-F]{16,128}$")

    /**
     * Accepts every form the engine shows:
     * - `mixai-live://pair?host=<ip>&port=17920&t=<token>&name=<engine>` (QR)
     * - `http://<ip>:17920/?t=<token>` (web remote link, also in the QR)
     * - `<ip>[:port]/?t=<token>` or `<ip>:port t=<token>` typed by hand.
     */
    fun parse(raw: String): PairedEngine? {
        val text = raw.trim()
        if (text.isEmpty()) return null
        val candidate = when {
            text.startsWith("mixai-live://", ignoreCase = true) -> text
            text.contains("://") -> text
            else -> "http://" + text.replace(" t=", "/?t=").replace(" ", "")
        }
        val uri = runCatching { URI(candidate) }.getOrNull() ?: return null
        val q = query(uri.rawQuery)
        val token = q["t"] ?: q["token"] ?: return null
        if (!TOKEN.matches(token)) return null
        val host: String
        val port: Int
        if (uri.scheme.equals("mixai-live", ignoreCase = true)) {
            host = q["host"] ?: return null
            port = q["port"]?.toIntOrNull() ?: DEFAULT_PORT
        } else {
            if (uri.scheme != "http" && uri.scheme != "https") return null
            host = uri.host?.removePrefix("[")?.removeSuffix("]") ?: return null
            port = if (uri.port > 0) uri.port else DEFAULT_PORT
        }
        if (host.isBlank() || port !in 1..65535) return null
        return PairedEngine(name = q["name"]?.takeIf { it.isNotBlank() } ?: "MixAI Live", host = host, port = port, token = token)
    }

    private fun query(raw: String?): Map<String, String> = raw.orEmpty().split('&').mapNotNull { kv ->
        val i = kv.indexOf('=')
        if (i <= 0) null else kv.substring(0, i) to URLDecoder.decode(kv.substring(i + 1), "UTF-8")
    }.toMap()
}
