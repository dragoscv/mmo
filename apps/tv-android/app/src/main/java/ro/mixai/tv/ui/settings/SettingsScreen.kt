package ro.mixai.tv.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.NoBackdrop
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

/** Settings sections; `id` is what `Route.Settings(section)` / deep links use. */
enum class SettingsSection(val id: String, val labelRes: Int) {
    Profiles("profiles", R.string.set_sec_profiles),
    Playback("playback", R.string.set_sec_playback),
    Subtitles("subtitles", R.string.set_sec_subtitles),
    Language("language", R.string.set_sec_language),
    Accessibility("accessibility", R.string.set_sec_accessibility),
    Navigation("navigation", R.string.set_sec_navigation),
    Server("server", R.string.set_sec_server),
    Account("account", R.string.set_sec_account),
    Cache("cache", R.string.set_sec_cache),
    Together("together", R.string.set_sec_together),
    Stats("stats", R.string.set_sec_stats),
    About("about", R.string.set_sec_about),
    ;

    companion object {
        fun of(id: String): SettingsSection = entries.firstOrNull { it.id == id.lowercase() } ?: Profiles
    }
}

private fun SettingsSection.icon(): ImageVector = when (this) {
    SettingsSection.Profiles -> Icons.Filled.Person
    SettingsSection.Playback -> Icons.Filled.PlayArrow
    SettingsSection.Subtitles -> MixaiIcons.Subtitles
    SettingsSection.Language -> MixaiIcons.Lyrics
    SettingsSection.Accessibility -> MixaiIcons.Accessibility
    SettingsSection.Navigation -> Icons.Filled.Menu
    SettingsSection.Server -> MixaiIcons.Cast
    SettingsSection.Account -> Icons.Filled.AccountCircle
    SettingsSection.Cache -> Icons.Filled.Refresh
    SettingsSection.Together -> MixaiIcons.Group
    SettingsSection.Stats -> MixaiIcons.Speed
    SettingsSection.About -> Icons.Filled.Info
}

/**
 * Settings (WP16-27): two panes — sections on the left, details on the right. Moving focus on the
 * left switches the details; Right enters them. [section] pre-selects (`profiles`, `playback`, …).
 * Every pre-WP16 setting (server, language, screen format, resume data, account) is kept.
 */
@Composable
fun SettingsScreen(deps: ScreenDeps, nav: Navigator, section: String) {
    NoBackdrop()
    var current by rememberSaveable { mutableStateOf(SettingsSection.of(section).id) }
    val sel = SettingsSection.of(current)
    val requesters = remember { SettingsSection.entries.associateWith { FocusRequester() } }
    LaunchedEffect(section) {
        if (section.isNotBlank()) current = SettingsSection.of(section).id
        delay(60)
        runCatching { requesters.getValue(SettingsSection.of(current)).requestFocus() }
    }

    Row(Modifier.fillMaxSize().padding(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = MixaiFocus.overscanTop)) {
        Column(Modifier.width(300.dp).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(stringResource(R.string.settings_title), style = MaterialTheme.typography.headlineLarge, color = Tokens.foreground)
            LazyColumn(Modifier.focusRestorer().focusGroup(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                itemsIndexed(SettingsSection.entries) { _, s ->
                    SectionItem(
                        label = stringResource(s.labelRes),
                        icon = s.icon(),
                        selected = s == sel,
                        modifier = Modifier.focusRequester(requesters.getValue(s)),
                        onFocus = { current = s.id },
                        onClick = { current = s.id },
                    )
                }
            }
        }
        Spacer(Modifier.width(40.dp))
        Box(
            Modifier.weight(1f).fillMaxHeight().background(Tokens.foreground.copy(alpha = 0.03f), RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)),
        ) {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 36.dp, vertical = 28.dp).focusGroup(),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                Text(stringResource(sel.labelRes), style = MaterialTheme.typography.headlineSmall, color = Tokens.foreground)
                when (sel) {
                    SettingsSection.Profiles -> ProfilesPane(deps, nav)
                    SettingsSection.Playback -> PlaybackPane(deps)
                    SettingsSection.Subtitles -> SubtitlesPane(deps)
                    SettingsSection.Language -> LanguagePane(deps)
                    SettingsSection.Accessibility -> AccessibilityPane(deps)
                    SettingsSection.Navigation -> NavigationPane(deps)
                    SettingsSection.Server -> ServerPane(deps, nav)
                    SettingsSection.Account -> AccountPane(deps)
                    SettingsSection.Cache -> CachePane(deps)
                    SettingsSection.Together -> TogetherPane(deps)
                    SettingsSection.Stats -> StatsPane(nav)
                    SettingsSection.About -> AboutPane(deps)
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

@Composable
private fun SectionItem(label: String, icon: ImageVector, selected: Boolean, modifier: Modifier, onFocus: () -> Unit, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = modifier.fillMaxWidth().onFocusChanged { if (it.isFocused) onFocus() },
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(12.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (selected) Tokens.foreground.copy(alpha = 0.10f) else Color.Transparent,
            contentColor = if (selected) Tokens.foreground else Tokens.mutedForeground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.03f),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(14.dp))
            Text(label, style = MaterialTheme.typography.titleSmall, maxLines = 1)
        }
    }
}
