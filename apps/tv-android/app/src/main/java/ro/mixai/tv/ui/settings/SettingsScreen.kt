package ro.mixai.tv.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.tv.BuildConfig
import ro.mixai.tv.R
import ro.mixai.tv.data.Health
import ro.mixai.tv.data.isKid
import ro.mixai.tv.ui.ScreenFormat
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.NoBackdrop
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.profiles.ProfileAvatar
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

private sealed interface ServerState {
    data object Checking : ServerState
    data class Ok(val health: Health) : ServerState
    data object Unreachable : ServerState
}

/**
 * Settings (moved from the legacy `ui/SettingsScreen.kt`): server, profiles, language, screen
 * format, resume data, account, version. [section] scrolls focus to a part (`profiles`, `server`);
 * the settings screen agent extends this (nav order, Live TV sources, playback, hub name).
 */
@Composable
fun SettingsScreen(deps: ScreenDeps, nav: Navigator, section: String) {
    NoBackdrop()
    val api = deps.api
    val settings = deps.settings
    var server by remember { mutableStateOf<ServerState>(ServerState.Checking) }
    var cleared by remember { mutableStateOf(false) }
    val first = remember { FocusRequester() }
    val profilesFocus = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    val formatKey by settings.screenFormat.collectAsState(initial = "auto")
    val active by deps.profiles.activeProfile.collectAsState()
    val signedInAs = if (deps.session.isSignedIn) deps.session.displayName else null

    LaunchedEffect(api) { server = try { ServerState.Ok(api.health()) } catch (_: Exception) { ServerState.Unreachable } }
    LaunchedEffect(section) { delay(50); runCatching { (if (section == "profiles") profilesFocus else first).requestFocus() } }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = MixaiFocus.overscan, vertical = 40.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Text(stringResource(R.string.settings_title), style = MaterialTheme.typography.headlineLarge, color = Tokens.foreground)

        Section(stringResource(R.string.settings_server)) {
            Text(api.baseUrl, color = Tokens.foreground, style = MaterialTheme.typography.titleMedium)
            Text(
                when (val s = server) {
                    ServerState.Checking -> stringResource(R.string.settings_server_checking)
                    is ServerState.Ok -> stringResource(R.string.settings_server_info, s.health.hostname, s.health.version)
                    ServerState.Unreachable -> stringResource(R.string.settings_server_unreachable)
                },
                color = if (server is ServerState.Unreachable) Tokens.destructive else Tokens.mutedForeground,
            )
            Spacer(Modifier.height(4.dp))
            OutlinedButton(onClick = deps.onChangeServer, modifier = Modifier.focusRequester(first)) { Text(stringResource(R.string.home_change_server)) }
        }

        Section(stringResource(R.string.wp16_settings_profiles)) {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                ProfileAvatar(active, size = 56.dp, showKidBadge = active?.isKid == true)
                Column {
                    Text(active?.name ?: stringResource(R.string.wp16_profile_none), color = Tokens.foreground, style = MaterialTheme.typography.titleMedium)
                    if (active?.hasPin == true) Text(stringResource(R.string.wp16_profile_locked), color = Tokens.mutedForeground, style = MaterialTheme.typography.bodySmall)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                SecondaryButton(stringResource(R.string.wp16_profile_switch), { nav.push(Route.ProfilePicker) }, Modifier.focusRequester(profilesFocus), icon = Icons.Filled.Person)
                SecondaryButton(stringResource(R.string.wp16_stub_stats), { nav.push(Route.Stats) }, icon = MixaiIcons.Speed)
            }
        }

        Section(stringResource(R.string.settings_language)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                val set: (String) -> Unit = { tag -> scope.launch { settings.setLocale(tag) } }
                ChoiceButton("", deps.localeTag, stringResource(R.string.settings_lang_system), set)
                ChoiceButton("ro", deps.localeTag, stringResource(R.string.settings_lang_ro), set)
                ChoiceButton("en", deps.localeTag, stringResource(R.string.settings_lang_en), set)
            }
        }

        Section(stringResource(R.string.settings_screen_format)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                val set: (String) -> Unit = { k -> scope.launch { settings.setScreenFormat(k) } }
                ChoiceButton(ScreenFormat.Auto.key, formatKey, stringResource(R.string.settings_screen_auto), set)
                ChoiceButton(ScreenFormat.Wide16x9.key, formatKey, "16:9", set)
                ChoiceButton(ScreenFormat.Ultra21x9.key, formatKey, "21:9", set)
                ChoiceButton(ScreenFormat.Super32x9.key, formatKey, "32:9", set)
            }
            Text(stringResource(R.string.settings_screen_hint), color = Tokens.mutedForeground, style = MaterialTheme.typography.bodySmall)
        }

        Section(stringResource(R.string.home_continue)) {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                OutlinedButton(onClick = { scope.launch { settings.clearProgress() }; cleared = true }) { Text(stringResource(R.string.settings_clear_progress)) }
                if (cleared) Text(stringResource(R.string.settings_cleared), color = Tokens.success, modifier = Modifier.padding(top = 12.dp))
            }
        }

        val signOut = deps.onSignOut
        if (signedInAs != null && signOut != null) Section(stringResource(R.string.settings_account)) {
            Text(signedInAs, color = Tokens.foreground)
            OutlinedButton(onClick = signOut) { Text(stringResource(R.string.home_sign_out)) }
        }

        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            if (nav.canPop) Button(onClick = { nav.pop() }) { Text(stringResource(R.string.action_back)) }
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.settings_app_version, BuildConfig.VERSION_NAME), color = Tokens.mutedForeground, modifier = Modifier.padding(top = 12.dp))
        }
    }
}

@Composable
internal fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = Tokens.brandCyanDark)
        content()
    }
}

@Composable
internal fun ChoiceButton(tag: String, current: String, label: String, onPick: (String) -> Unit) {
    if (tag == current) Button(onClick = { onPick(tag) }) { Text(label) }
    else OutlinedButton(onClick = { onPick(tag) }) { Text(label) }
}
