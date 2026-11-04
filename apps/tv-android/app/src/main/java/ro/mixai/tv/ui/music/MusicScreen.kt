package ro.mixai.tv.ui.music

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import ro.mixai.tv.R
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PlaceholderScreen
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.ScreenDeps

// STUB (WP16 foundation): placeholder body; the music screen agent replaces it. Keep the signature.
@Suppress("UNUSED_PARAMETER")
@Composable
fun MusicScreen(deps: ScreenDeps, nav: Navigator) {
    PlaceholderScreen(
        title = stringResource(R.string.wp16_nav_music),
        icon = MixaiIcons.MusicNote,
        message = stringResource(R.string.wp16_stub_message),
    )
}
