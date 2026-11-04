package ro.mixai.tv.ui.title

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import ro.mixai.tv.R
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PlaceholderScreen
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.ScreenDeps

// STUB (WP16 foundation): placeholder body; the title screen agent replaces it. Keep the signature.
@Suppress("UNUSED_PARAMETER")
@Composable
fun TitleScreen(deps: ScreenDeps, nav: Navigator, kind: String, tmdbId: Long) {
    PlaceholderScreen(
        title = stringResource(R.string.wp16_stub_title),
        icon = MixaiIcons.Movie,
        message = stringResource(R.string.wp16_stub_message),
    )
}
