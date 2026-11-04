package ro.mixai.tv.ui.search

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import ro.mixai.tv.R
import ro.mixai.tv.ui.components.PlaceholderScreen
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.ScreenDeps

// STUB (WP16 foundation): placeholder body; the search screen agent replaces it. Keep the signature.
@Suppress("UNUSED_PARAMETER")
@Composable
fun SearchScreen(deps: ScreenDeps, nav: Navigator, initial: String) {
    PlaceholderScreen(
        title = stringResource(R.string.wp16_nav_search),
        icon = Icons.Filled.Search,
        message = stringResource(R.string.wp16_stub_message),
    )
}
