package ro.mixai.app

import android.content.Context
import android.util.Log
import io.sentry.android.core.SentryAndroid

/**
 * Sentry crash reporting, env-gated: no DSN in `BuildConfig.SENTRY_DSN` (gradle property / env
 * `MIXAI_SENTRY_DSN_PHONE`) → never initialised. Data safety: no PII, no screenshots / view hierarchy,
 * no user IP (`sendDefaultPii=false`), release = versionName.
 */
object Telemetry {
    const val TAG = "MixaiSentry"

    /** Pure gate (unit-tested). */
    fun enabledFor(dsn: String): Boolean = dsn.isNotBlank() && dsn.startsWith("https://")

    fun init(context: Context) {
        val dsn = BuildConfig.SENTRY_DSN
        if (!enabledFor(dsn)) {
            Log.i(TAG, "Sentry disabled (no DSN)")
            return
        }
        SentryAndroid.init(context) { o ->
            o.dsn = dsn
            o.release = "ro.mixai.app@${BuildConfig.VERSION_NAME}"
            o.environment = if (BuildConfig.DEBUG) "debug" else "production"
            o.isSendDefaultPii = false
            o.isAttachScreenshot = false
            o.isAttachViewHierarchy = false
            o.tracesSampleRate = 0.0
            o.isEnableUserInteractionBreadcrumbs = false
        }
        Log.i(TAG, "Sentry enabled release=${BuildConfig.VERSION_NAME}")
    }
}
