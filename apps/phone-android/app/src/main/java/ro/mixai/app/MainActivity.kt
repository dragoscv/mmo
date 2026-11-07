package ro.mixai.app

import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import ro.mixai.mobile.theme.MixaiTheme
import ro.mixai.mobile.LocalMobileConfig
import java.util.Locale

/** PiP policy for the current screen (set by the player). */
object PipController {
    /** True while a video plays: Home/recents auto-enters PiP. */
    val enabled = mutableStateOf(false)
    val aspect = mutableStateOf(Rational(16, 9))
    /** True while the activity is in PiP (player hides its OSD). */
    val inPip = mutableStateOf(false)
}

class MainActivity : ComponentActivity() {
    /** Pending `mixai://title/<kind>/<id>` or `https://mixai.ro/media/<kind>/<id>`; consumed by AppRoot. */
    private val deepLink = mutableStateOf<Pair<String, Long>?>(null)
    private var ready = false

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        splash.setKeepOnScreenCondition { !ready }
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        deepLink.value = parseDeepLink(intent)
        val settings = (application as MixaiPhoneApp).settings
        setContent {
            val localeTag by settings.locale.collectAsState(initial = "")
            LocalizedContent(localeTag) {
                MixaiTheme { CompositionLocalProvider(LocalMobileConfig provides (application as MixaiPhoneApp).phone.config) {
                    val conn by settings.connection.collectAsState(initial = null)
                    val session by settings.session.collectAsState(initial = null)
                    val c = conn ?: return@CompositionLocalProvider
                    val s = session ?: return@CompositionLocalProvider
                    ready = true
                    val link by deepLink
                    AppRoot(c, s, settings, localeTag, link) { deepLink.value = null }
                } }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        parseDeepLink(intent)?.let { deepLink.value = it }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // API 31+ uses setAutoEnterEnabled (updatePip); this covers launchers that ignore it.
        if (PipController.enabled.value && !isInPictureInPictureMode) runCatching { enterPictureInPictureMode(pipParams()) }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        PipController.inPip.value = isInPictureInPictureMode
    }

    fun pipParams(): PictureInPictureParams = PictureInPictureParams.Builder()
        .setAspectRatio(PipController.aspect.value)
        .setAutoEnterEnabled(PipController.enabled.value)
        .setSeamlessResizeEnabled(true)
        .build()

    /** Called by the player when PiP eligibility / aspect changes. */
    fun updatePip() { runCatching { setPictureInPictureParams(pipParams()) } }

    companion object {
        /** Room id of the last `mixai://together/<roomId>` link (consumed by AppRoot). */
        @Volatile var pendingRoomId: String? = null

        fun parseDeepLink(intent: Intent?): Pair<String, Long>? {
            val data: Uri = intent?.data ?: return null
            val seg = data.pathSegments
            if (data.scheme == "mixai" && data.host == "downloads") return "downloads" to 0L
            if (data.scheme == "mixai" && data.host == "together") {
                pendingRoomId = seg.firstOrNull()?.takeIf { it.isNotBlank() }
                return "together" to 0L
            }
            return when {
                data.scheme == "mixai" && data.host == "title" && seg.size >= 2 -> seg[0] to (seg[1].toLongOrNull() ?: return null)
                data.scheme == "https" && seg.size >= 3 && seg[0] == "media" -> seg[1] to (seg[2].toLongOrNull() ?: return null)
                else -> null
            }?.takeIf { it.first == "movie" || it.first == "tv" }
        }
    }
}

/** Locale override ("" = system), same as the TV app. */
@Composable
private fun LocalizedContent(tag: String, content: @Composable () -> Unit) {
    val base = LocalContext.current
    val baseConfig = LocalConfiguration.current
    if (tag.isBlank()) { content(); return }
    val locale = remember(tag) { Locale.forLanguageTag(tag) }
    val ctx: Context = remember(tag, base, baseConfig) {
        Locale.setDefault(locale)
        base.createConfigurationContext(Configuration(baseConfig).apply { setLocale(locale) })
    }
    key(tag) {
        CompositionLocalProvider(LocalContext provides ctx, LocalConfiguration provides ctx.resources.configuration) { content() }
    }
}
