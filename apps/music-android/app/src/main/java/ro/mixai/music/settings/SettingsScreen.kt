package ro.mixai.music.settings

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.GraphicEq
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Policy
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material.icons.automirrored.outlined.QueueMusic
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ro.mixai.mobile.ui.ProfileAvatar
import ro.mixai.music.BuildConfig
import ro.mixai.music.MixaiMusicApp
import ro.mixai.music.MusicGraph
import ro.mixai.music.R
import ro.mixai.tv.data.AccountSession
import ro.mixai.tv.data.Connection

private val LANGUAGES = listOf("" to R.string.settings_language_system, "ro" to null, "en" to null)
private val THEMES = listOf("system" to R.string.settings_theme_system, "dark" to R.string.settings_theme_dark, "light" to R.string.settings_theme_light)
private val UPCOMING = listOf(0, 5, 10, 25)
private val CAPS = listOf(1, 2, 5, 10, 25, 0)
private val CROSSFADES = listOf(0, 3, 6, 9, 12)

/** Server, account, profile, language, theme, about. */
@Composable
fun SettingsScreen(
    app: MixaiMusicApp,
    graph: MusicGraph,
    conn: Connection,
    session: AccountSession,
    localeTag: String,
    onProfiles: () -> Unit,
    onSignIn: () -> Unit,
    onChangeServer: () -> Unit,
    onSignOut: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val theme by app.musicSettings.theme.collectAsState(initial = "system")
    val wifiOnly by app.musicSettings.wifiOnly.collectAsState(initial = true)
    val upcoming by app.musicSettings.upcoming.collectAsState(initial = 0)
    val capGb by app.musicSettings.capGb.collectAsState(initial = 2)
    val crossfade by app.musicSettings.crossfadeSec.collectAsState(initial = 0)
    val normalize by app.musicSettings.normalize.collectAsState(initial = true)
    val automix by app.musicSettings.automix.collectAsState(initial = true)
    val profile by graph.profiles.activeProfile.collectAsState()
    var dialog by rememberSaveable { mutableStateOf("") }

    Column(Modifier.fillMaxSize()) {
        Text(
            stringResource(R.string.settings_title), style = MaterialTheme.typography.headlineLarge,
            modifier = Modifier.statusBarsPadding().padding(start = 20.dp, end = 16.dp, top = 12.dp, bottom = 8.dp),
        )
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Row(
                    Icons.Outlined.Dns, stringResource(R.string.settings_server),
                    conn.baseUrl, onClick = onChangeServer,
                    trailing = stringResource(R.string.settings_change_server),
                )
            }
            profile?.let { p ->
                item {
                    ListItem(
                        headlineContent = { Text(p.name) },
                        leadingContent = { ProfileAvatar(p, 40.dp) },
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
                        modifier = Modifier.clickable(onClick = onProfiles),
                    )
                }
            }
            item {
                if (session.isSignedIn) {
                    Row(
                        Icons.Outlined.AccountCircle, stringResource(R.string.settings_account),
                        stringResource(R.string.settings_signed_in_as, session.userName.ifBlank { session.userId }), onClick = null,
                    )
                } else {
                    Row(
                        Icons.Outlined.AccountCircle, stringResource(R.string.settings_account),
                        stringResource(R.string.settings_not_signed_in), onClick = onSignIn, trailing = stringResource(R.string.settings_sign_in),
                    )
                }
            }
            item {
                Row(Icons.Outlined.Language, stringResource(R.string.settings_language), languageLabel(localeTag), onClick = { dialog = "lang" })
            }
            item {
                Row(Icons.Outlined.DarkMode, stringResource(R.string.settings_theme), stringResource(THEMES.first { it.first == theme }.second), onClick = { dialog = "theme" })
            }
            item {
                Row(Icons.Outlined.Tune, stringResource(R.string.settings_crossfade), crossfadeLabel(crossfade), onClick = { dialog = "crossfade" })
            }
            item {
                ListItem(
                    headlineContent = { Text(stringResource(R.string.settings_automix)) },
                    supportingContent = { Text(stringResource(R.string.settings_automix_hint)) },
                    leadingContent = { Icon(Icons.Outlined.GraphicEq, contentDescription = null) },
                    trailingContent = {
                        Switch(checked = automix, enabled = crossfade > 0, onCheckedChange = { v -> scope.launch { app.musicSettings.setAutomix(v) } })
                    },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
                    modifier = Modifier.clickable(enabled = crossfade > 0) { scope.launch { app.musicSettings.setAutomix(!automix) } },
                )
            }
            item {
                ListItem(
                    headlineContent = { Text(stringResource(R.string.settings_normalize)) },
                    supportingContent = { Text(stringResource(R.string.settings_normalize_hint)) },
                    leadingContent = { Icon(Icons.Outlined.GraphicEq, contentDescription = null) },
                    trailingContent = { Switch(checked = normalize, onCheckedChange = { v -> scope.launch { app.musicSettings.setNormalize(v) } }) },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
                    modifier = Modifier.clickable { scope.launch { app.musicSettings.setNormalize(!normalize) } },
                )
            }
            item {
                ListItem(
                    headlineContent = { Text(stringResource(R.string.settings_dl_wifi)) },
                    supportingContent = { Text(stringResource(R.string.settings_dl_wifi_hint)) },
                    leadingContent = { Icon(Icons.Outlined.Wifi, contentDescription = null) },
                    trailingContent = { Switch(checked = wifiOnly, onCheckedChange = { v -> scope.launch { app.musicSettings.setWifiOnly(v) } }) },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
                    modifier = Modifier.clickable { scope.launch { app.musicSettings.setWifiOnly(!wifiOnly) } },
                )
            }
            item {
                Row(Icons.AutoMirrored.Outlined.QueueMusic, stringResource(R.string.settings_dl_upcoming), upcomingLabel(upcoming), onClick = { dialog = "upcoming" })
            }
            item {
                Row(Icons.Outlined.Storage, stringResource(R.string.settings_dl_cap), capLabel(capGb), onClick = { dialog = "cap" })
            }
            item {
                Row(Icons.Outlined.Policy, stringResource(R.string.settings_privacy), null, onClick = {
                    runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${app.config.webOrigin}/privacy")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }
                })
            }
            item {
                Row(Icons.Outlined.Info, stringResource(R.string.settings_version, BuildConfig.VERSION_NAME), stringResource(R.string.settings_licenses), onClick = null)
            }
            if (session.isSignedIn) {
                item { Row(Icons.AutoMirrored.Outlined.Logout, stringResource(R.string.settings_sign_out), null, onClick = onSignOut) }
            }
        }
    }

    when (dialog) {
        "lang" -> ChoiceDialog(
            title = stringResource(R.string.settings_language),
            options = LANGUAGES.map { (tag, _) -> tag to languageLabel(tag) },
            selected = localeTag,
            onPick = { tag -> scope.launch { app.settings.setLocale(tag) }; dialog = "" },
            onDismiss = { dialog = "" },
        )
        "theme" -> ChoiceDialog(
            title = stringResource(R.string.settings_theme),
            options = THEMES.map { (k, label) -> k to stringResource(label) },
            selected = theme,
            onPick = { mode -> scope.launch { app.musicSettings.setTheme(mode) }; dialog = "" },
            onDismiss = { dialog = "" },
        )
        "upcoming" -> ChoiceDialog(
            title = stringResource(R.string.settings_dl_upcoming),
            options = UPCOMING.map { it.toString() to upcomingLabel(it) },
            selected = upcoming.toString(),
            onPick = { n -> scope.launch { app.musicSettings.setUpcoming(n.toInt()) }; dialog = "" },
            onDismiss = { dialog = "" },
        )
        "crossfade" -> ChoiceDialog(
            title = stringResource(R.string.settings_crossfade),
            options = CROSSFADES.map { it.toString() to crossfadeLabel(it) },
            selected = crossfade.toString(),
            onPick = { s -> scope.launch { app.musicSettings.setCrossfadeSec(s.toInt()) }; dialog = "" },
            onDismiss = { dialog = "" },
        )
        "cap" -> ChoiceDialog(
            title = stringResource(R.string.settings_dl_cap),
            options = CAPS.map { it.toString() to capLabel(it) },
            selected = capGb.toString(),
            onPick = { gb -> scope.launch { app.musicSettings.setCapGb(gb.toInt()) }; dialog = "" },
            onDismiss = { dialog = "" },
        )
    }
}

@Composable
private fun upcomingLabel(n: Int): String =
    if (n <= 0) stringResource(R.string.settings_dl_upcoming_off) else stringResource(R.string.settings_dl_upcoming_n, n)

@Composable
private fun crossfadeLabel(s: Int): String =
    if (s <= 0) stringResource(R.string.settings_crossfade_off) else stringResource(R.string.settings_crossfade_s, s)

@Composable
private fun capLabel(gb: Int): String =
    if (gb <= 0) stringResource(R.string.settings_dl_cap_none) else stringResource(R.string.settings_dl_cap_gb, gb)

/** Language names are shown in their own language (not translated). */
@Composable
private fun languageLabel(tag: String): String = when (tag) {
    "ro" -> "Română"
    "en" -> "English"
    else -> stringResource(R.string.settings_language_system)
}

@Composable
private fun Row(icon: ImageVector, title: String, subtitle: String?, onClick: (() -> Unit)?, trailing: String? = null) {
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = subtitle?.let { { Text(it) } },
        leadingContent = { Icon(icon, contentDescription = null) },
        trailingContent = trailing?.let { { Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge) } },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
        modifier = if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier,
    )
}

@Composable
private fun ChoiceDialog(title: String, options: List<Pair<String, String>>, selected: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                options.forEach { (key, label) ->
                    androidx.compose.foundation.layout.Row(
                        Modifier.clickable { onPick(key) }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = key == selected, onClick = { onPick(key) })
                        Text(label)
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(ro.mixai.mobile.R.string.common_action_close)) } },
    )
}
