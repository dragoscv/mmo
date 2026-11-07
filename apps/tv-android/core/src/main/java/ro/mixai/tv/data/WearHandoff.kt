package ro.mixai.tv.data

/**
 * Server connection handed from MixAI Music on the phone to the watch over the Wearable Data Layer
 * (WP17-41g). Data items are private to apps with the same applicationId + signing key, so the device
 * token never leaves the user's paired devices. Pure helpers so both sides share one contract.
 */
object WearHandoff {
    /** DataItem path published by the phone app. */
    const val PATH = "/mixai-music/connection"
    const val KEY_BASE = "baseUrl"
    const val KEY_TOKEN = "token"
    const val KEY_USER = "userId"
    const val KEY_PROFILE = "profileId"
    const val KEY_AT = "at"

    data class Payload(val baseUrl: String, val token: String, val userId: String = "", val profileId: String = "") {
        val isComplete: Boolean get() = baseUrl.isNotBlank() && token.isNotBlank()
    }

    fun toMap(p: Payload, now: Long = System.currentTimeMillis()): Map<String, String> = mapOf(
        KEY_BASE to p.baseUrl, KEY_TOKEN to p.token, KEY_USER to p.userId, KEY_PROFILE to p.profileId, KEY_AT to now.toString(),
    )

    /** Null unless both base URL (http/https) and token are present. */
    fun fromMap(m: Map<String, String?>): Payload? {
        val base = m[KEY_BASE]?.trim().orEmpty()
        val token = m[KEY_TOKEN]?.trim().orEmpty()
        if (token.isBlank() || !(base.startsWith("http://") || base.startsWith("https://"))) return null
        return Payload(base.trimEnd('/'), token, m[KEY_USER].orEmpty(), m[KEY_PROFILE].orEmpty())
    }
}
