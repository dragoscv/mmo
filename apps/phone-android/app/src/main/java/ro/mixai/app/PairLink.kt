package ro.mixai.app

/**
 * Quick Connect approve link (D59, WP17-101): a browser on /connect or a TV shows a QR with
 * `https://mixai.ro/pair?host=&port=&code=` (approveUrl) or `mixai://pair?host=&port=&code=`.
 * The phone approves the code on ITS OWN paired server; host/port only tell which server the code belongs to.
 */
data class PairLink(val code: String, val host: String?, val port: Int?)

private val PAIR_HOSTS = setOf("mixai.ro", "music.mixai.ro", "tv.mixai.ro")

fun parsePairLink(scheme: String?, host: String?, path: String?, query: (String) -> String?): PairLink? {
    val isPair = when (scheme?.lowercase()) {
        "mixai" -> host == "pair"
        "https" -> host?.lowercase() in PAIR_HOSTS && path?.trimEnd('/') == "/pair"
        else -> false
    }
    if (!isPair) return null
    val code = query("code")?.filter { it.isDigit() }?.takeIf { it.length == 6 } ?: return null
    return PairLink(code, query("host")?.takeIf { it.isNotBlank() }, query("port")?.toIntOrNull())
}

/** True when the link names a different server than the one this phone is paired with (warn before approving). */
fun PairLink.namesOtherServer(baseUrl: String): Boolean {
    val h = host ?: return false
    val uri = runCatching { java.net.URI(baseUrl) }.getOrNull() ?: return false
    if (!uri.host.equals(h, ignoreCase = true)) return true
    val own = if (uri.port > 0) uri.port else if (uri.scheme == "https") 443 else 80
    return port != null && port != own
}
