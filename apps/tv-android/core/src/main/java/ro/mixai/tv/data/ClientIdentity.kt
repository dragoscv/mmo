package ro.mixai.tv.data

// Who is talking to the MMO Server / mixai.ro. The `:core` module is shared by the TV app and the
// phone app, so platform, version and User-Agent come from the host app instead of BuildConfig.
// Set once in Application.onCreate (before any service or repository runs).
data class ClientIdentity(
    /** `platform` sent on pairing, device-code sign-in and hub `hello` (e.g. "android-tv"). */
    val platform: String,
    /** App versionName. */
    val appVersion: String,
    /** Device name when `Build.MODEL` is unavailable and the user did not pick one. */
    val fallbackDeviceName: String,
    /** HTTP User-Agent product token (e.g. "MixAI-TV" → `MixAI-TV/2.0.2`). */
    val userAgentPrefix: String,
) {
    val userAgent: String get() = "$userAgentPrefix/$appVersion"

    /** Hub `hello.app` tag, e.g. `mixai-tv/2.0.2`. */
    val appTag: String get() = "${userAgentPrefix.lowercase()}/$appVersion"

    companion object {
        /** Process-wide identity; the default only serves JVM unit tests. */
        @Volatile
        var current: ClientIdentity = ClientIdentity("android", "0.0.0", "Android", "MixAI")
    }
}
