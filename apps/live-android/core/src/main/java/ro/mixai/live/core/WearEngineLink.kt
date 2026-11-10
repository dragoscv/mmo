package ro.mixai.live.core

/**
 * Phone → watch hand-off over the Wearable Data Layer (DataClient). The phone puts the paired engine JSON
 * ([PairedEngine.toJson]) at [PATH]; the watch connects to it directly over Wi-Fi with the same [LiveClient].
 * Constants only: Play Services stays out of :live-core.
 */
object WearEngineLink {
    const val PATH = "/live/engine"
    const val KEY_ENGINE = "engine"
    const val CAPABILITY_PHONE = "mixai_live_phone"
    const val CAPABILITY_WATCH = "mixai_live_watch"
}
