package ro.mixai.music

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
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
import ro.mixai.mobile.LocalMobileConfig
import ro.mixai.mobile.theme.MixaiTheme
import ro.mixai.music.nav.Dest
import ro.mixai.music.nav.MusicNavigator
import java.util.Locale

class MainActivity : ComponentActivity() {
    /** Pending `mixai-music://…` destination; consumed by MusicRoot once connected. */
    private val link = mutableStateOf<Dest?>(null)
    private var ready = false

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        splash.setKeepOnScreenCondition { !ready }
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        link.value = parse(intent)
        val app = application as MixaiMusicApp
        setContent {
            val localeTag by app.settings.locale.collectAsState(initial = "")
            val theme by app.musicSettings.theme.collectAsState(initial = "system")
            LocalizedContent(localeTag) {
                MixaiTheme(theme) {
                    CompositionLocalProvider(LocalMobileConfig provides app.config) {
                        val conn by app.settings.connection.collectAsState(initial = null)
                        val session by app.settings.session.collectAsState(initial = null)
                        val c = conn ?: return@CompositionLocalProvider
                        val s = session ?: return@CompositionLocalProvider
                        ready = true
                        val pending by link
                        MusicRoot(app, c, s, localeTag, pending) { link.value = null }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        parse(intent)?.let { link.value = it }
    }

    private fun parse(intent: Intent?): Dest? {
        val data = intent?.data ?: return null
        return MusicNavigator.parseLink(data.scheme, data.host, data.pathSegments)
    }
}

/** Locale override ("" = system), same as the phone and TV apps. */
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
