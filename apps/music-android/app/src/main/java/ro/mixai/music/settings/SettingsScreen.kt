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
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Policy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
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
    }
}

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
