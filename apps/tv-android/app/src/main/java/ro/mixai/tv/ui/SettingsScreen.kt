package ro.mixai.tv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import ro.mixai.tv.BuildConfig
import ro.mixai.tv.R
import ro.mixai.tv.data.Health
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.ui.theme.Tokens

private sealed interface ServerState {
    data object Checking : ServerState
    data class Ok(val health: Health) : ServerState
    data object Unreachable : ServerState
}

@Composable
fun SettingsScreen(
    api: MmoApi,
    localeTag: String,
    signedInAs: String?,
    onLocale: (String) -> Unit,
    onClearProgress: () -> Unit,
    onChangeServer: () -> Unit,
    onSignOut: (() -> Unit)?,
    onBack: () -> Unit,
) {
    var server by remember { mutableStateOf<ServerState>(ServerState.Checking) }
    var cleared by remember { mutableStateOf(false) }
    val first = remember { FocusRequester() }

    LaunchedEffect(api) { server = try { ServerState.Ok(api.health()) } catch (_: Exception) { ServerState.Unreachable } }
    LaunchedEffect(Unit) { delay(50); runCatching { first.requestFocus() } }

    Column(Modifier.fillMaxSize().padding(horizontal = 64.dp, vertical = 48.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
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
            OutlinedButton(onClick = onChangeServer, modifier = Modifier.focusRequester(first)) { Text(stringResource(R.string.home_change_server)) }
        }

        Section(stringResource(R.string.settings_language)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                LangButton("", localeTag, stringResource(R.string.settings_lang_system), onLocale)
                LangButton("ro", localeTag, stringResource(R.string.settings_lang_ro), onLocale)
                LangButton("en", localeTag, stringResource(R.string.settings_lang_en), onLocale)
            }
        }

        Section(stringResource(R.string.home_continue)) {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                OutlinedButton(onClick = { onClearProgress(); cleared = true }) { Text(stringResource(R.string.settings_clear_progress)) }
                if (cleared) Text(stringResource(R.string.settings_cleared), color = Tokens.success, modifier = Modifier.padding(top = 12.dp))
            }
        }

        if (signedInAs != null && onSignOut != null) Section(stringResource(R.string.settings_account)) {
            Text("👤 $signedInAs", color = Tokens.foreground)
            OutlinedButton(onClick = onSignOut) { Text(stringResource(R.string.home_sign_out)) }
        }

        Spacer(Modifier.weight(1f))
        Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Button(onClick = onBack) { Text(stringResource(R.string.action_back)) }
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.settings_app_version, BuildConfig.VERSION_NAME), color = Tokens.mutedForeground, modifier = Modifier.padding(top = 12.dp))
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = Tokens.brandCyanDark)
        content()
    }
}

@Composable
private fun LangButton(tag: String, current: String, label: String, onLocale: (String) -> Unit) {
    if (tag == current) Button(onClick = { onLocale(tag) }) { Text(label) }
    else OutlinedButton(onClick = { onLocale(tag) }) { Text(label) }
}
