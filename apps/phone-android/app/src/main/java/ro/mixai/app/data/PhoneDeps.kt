package ro.mixai.app.data

import ro.mixai.app.BuildConfig
import ro.mixai.mobile.MobileConfig
import ro.mixai.mobile.auth.SessionVault
import ro.mixai.mobile.auth.WebApi

/** Phone-only singletons (process lifetime), owned by [ro.mixai.app.MixaiPhoneApp]. */
class PhoneDeps(
    val settings: PhoneSettings,
    val vault: SessionVault,
    val config: MobileConfig = MobileConfig(
        origin = BuildConfig.MIXAI_ORIGIN,
        webOrigin = BuildConfig.MIXAI_WEB_ORIGIN,
        googleWebClientId = BuildConfig.GOOGLE_WEB_CLIENT_ID,
        appVersion = BuildConfig.VERSION_NAME,
        deviceLabel = "MixAI",
    ),
) {
    val web: WebApi get() = config.web
}
