package ro.mixai.tv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.launch
import ro.mixai.tv.R
import ro.mixai.tv.data.DiscoveredServer
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.Settings
import ro.mixai.tv.ui.theme.Tokens
import java.net.URI

private sealed interface Probe {
    data object Idle : Probe
    data object Busy : Probe
    data class Ok(val version: String, val hostname: String, val paired: Boolean, val pairingSupported: Boolean) : Probe
    /** `message == null` → the host field was empty (connect_err_host). */
    data class Fail(val message: String?) : Probe
}

@Composable
fun ConnectScreen(
    initialHost: String,
    initialToken: String,
    onConnected: (host: String, token: String) -> Unit,
    onQuickConnect: (DiscoveredServer) -> Unit = {},
) {
    var host by remember { mutableStateOf(initialHost) }
    var token by remember { mutableStateOf(initialToken) }
    var probe by remember { mutableStateOf<Probe>(Probe.Idle) }
    val scope = rememberCoroutineScope()
    val hostFocus = remember { FocusRequester() }
    val connectFocus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current

    LaunchedEffect(Unit) { hostFocus.requestFocus() }

    fun test() {
        val base = Settings.normalizeBaseUrl(host)
        if (base.isEmpty()) { probe = Probe.Fail(null); return }
        probe = Probe.Busy
        scope.launch {
            try {
                val api = MmoApi(base, token.trim())
                val h = api.health()
                val paired = token.isNotBlank() && api.checkToken()
                val supported = try { api.pairInfo().pairingSupported } catch (_: Exception) { false }
                probe = Probe.Ok(h.version, h.hostname, paired, supported)
                if (paired) onConnected(base, token.trim())
            } catch (e: Exception) {
                probe = Probe.Fail(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    Box(Modifier.fillMaxSize().padding(64.dp), contentAlignment = Alignment.Center) {
        Column(Modifier.width(720.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.displaySmall, color = Tokens.foreground)
            Text(stringResource(R.string.connect_subtitle), style = MaterialTheme.typography.titleMedium, color = Tokens.mutedForeground)

            TvField(
                value = host, onValueChange = { host = it }, label = stringResource(R.string.connect_host_label),
                modifier = Modifier.focusRequester(hostFocus), keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Next, onIme = { focusManager.moveFocus(FocusDirection.Down) },
            )
            TvField(
                value = token, onValueChange = { token = it }, label = stringResource(R.string.connect_token_label), keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done, onIme = { connectFocus.requestFocus(); test() },
            )

            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Button(onClick = { test() }, enabled = probe != Probe.Busy, modifier = Modifier.focusRequester(connectFocus)) { Text(stringResource(R.string.connect_submit)) }
            }

            Spacer(Modifier.height(4.dp))
            when (val p = probe) {
                Probe.Idle -> {}
                Probe.Busy -> Text(stringResource(R.string.connect_checking), color = Tokens.mutedForeground)
                is Probe.Ok -> {
                    Text(stringResource(R.string.connect_ok, p.hostname, p.version), color = Tokens.success)
                    if (!p.paired) {
                        Text(
                            stringResource(if (token.isBlank()) R.string.connect_not_paired else R.string.connect_token_rejected),
                            color = Tokens.warning,
                        )
                        if (p.pairingSupported) {
                            val quickFocus = remember { FocusRequester() }
                            LaunchedEffect(Unit) { kotlinx.coroutines.delay(50); runCatching { quickFocus.requestFocus() } }
                            Button(
                                modifier = Modifier.focusRequester(quickFocus),
                                onClick = {
                                    val base = Settings.normalizeBaseUrl(host)
                                    val u = URI(base)
                                    onQuickConnect(DiscoveredServer(u.host, if (u.port > 0) u.port else 17899, p.hostname.ifBlank { u.host }, p.version))
                                },
                            ) { Text(stringResource(R.string.connect_quick)) }
                        } else Text(stringResource(R.string.connect_enter_token), color = Tokens.mutedForeground)
                    }
                }
                is Probe.Fail -> Text(stringResource(R.string.connect_fail, p.message ?: stringResource(R.string.connect_err_host)), color = Tokens.destructive)
            }
        }
    }
}

@Composable
private fun TvField(
    value: String, onValueChange: (String) -> Unit, label: String,
    modifier: Modifier = Modifier, keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Next, onIme: () -> Unit = {},
) {
    val focusManager = LocalFocusManager.current
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { androidx.compose.material3.Text(label) },
        singleLine = true,
        modifier = modifier.width(720.dp).onPreviewKeyEvent { ev ->
            // The IME swallows D-pad on TV; move focus between fields/buttons ourselves.
            if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            when (ev.key) {
                Key.DirectionDown -> focusManager.moveFocus(FocusDirection.Down)
                Key.DirectionUp -> focusManager.moveFocus(FocusDirection.Up)
                else -> false
            }
        },
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
        keyboardActions = KeyboardActions(onNext = { onIme() }, onDone = { onIme() }),
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = Tokens.foreground, unfocusedTextColor = Tokens.foreground,
            focusedBorderColor = Tokens.primary, unfocusedBorderColor = Tokens.input,
            focusedLabelColor = Tokens.primary, unfocusedLabelColor = Tokens.mutedForeground,
            cursorColor = Tokens.primary,
        ),
    )
}
