package ro.mixai.app.data

import ro.mixai.app.BuildConfig

/** Phone-only singletons (process lifetime), owned by [ro.mixai.app.MixaiPhoneApp]. */
class PhoneDeps(
    val settings: PhoneSettings,
    val vault: SessionVault,
    val web: WebApi = WebApi(BuildConfig.MIXAI_WEB_ORIGIN),
)
