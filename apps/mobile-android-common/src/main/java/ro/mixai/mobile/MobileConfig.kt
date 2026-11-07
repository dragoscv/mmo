package ro.mixai.mobile

import androidx.compose.runtime.staticCompositionLocalOf
import ro.mixai.mobile.auth.WebApi

/**
 * Per-app values the shared onboarding needs (each app passes its own BuildConfig).
 * `origin` = device-code flow host, `webOrigin` = native Google exchange + push.
 */
data class MobileConfig(
    val origin: String,
    val webOrigin: String,
    val googleWebClientId: String,
    val appVersion: String,
    /** Shown in device lists ("Pixel 9 · MixAI Music"). */
    val deviceLabel: String,
) {
    val web: WebApi by lazy { WebApi(webOrigin) }
}

val LocalMobileConfig = staticCompositionLocalOf<MobileConfig> { error("MobileConfig not provided") }
