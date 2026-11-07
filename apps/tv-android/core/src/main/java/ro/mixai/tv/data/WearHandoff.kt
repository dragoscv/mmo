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

    /** Phone's active music output (WP17-41h), shown on the watch with "Back to phone". */
    const val OUTPUT_PATH = "/mixai-music/output"
    /** Message path the watch sends to move the phone's music back to the phone. */
    const val MSG_OUTPUT_LOCAL = "/mixai-music/output/local"
    const val KEY_OUTPUT_KIND = "kind"
    const val KEY_OUTPUT_NAME = "name"

    data class Output(val kind: String, val name: String) {
        val isRemote: Boolean get() = kind.isNotBlank() && kind != "local"
    }

    fun outputToMap(o: Output, now: Long = System.currentTimeMillis()): Map<String, String> =
        mapOf(KEY_OUTPUT_KIND to o.kind, KEY_OUTPUT_NAME to o.name, KEY_AT to now.toString())

    fun outputFromMap(m: Map<String, String?>): Output? {
        val kind = m[KEY_OUTPUT_KIND]?.trim().orEmpty()
        if (kind.isBlank()) return null
        return Output(kind, m[KEY_OUTPUT_NAME]?.trim().orEmpty())
    }

    /** Null unless both base URL (http/https) and token are present. */
    fun fromMap(m: Map<String, String?>): Payload? {
        val base = m[KEY_BASE]?.trim().orEmpty()
        val token = m[KEY_TOKEN]?.trim().orEmpty()
        if (token.isBlank() || !(base.startsWith("http://") || base.startsWith("https://"))) return null
        return Payload(base.trimEnd('/'), token, m[KEY_USER].orEmpty(), m[KEY_PROFILE].orEmpty())
    }
}
