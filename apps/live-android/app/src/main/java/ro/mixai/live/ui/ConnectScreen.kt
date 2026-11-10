package ro.mixai.live.ui

import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import ro.mixai.live.LiveApp
import ro.mixai.live.MainActivity
import ro.mixai.live.R
import ro.mixai.live.core.Discovery
import ro.mixai.live.core.PairedEngine
import ro.mixai.live.core.Pairing
import ro.mixai.live.core.Phase
import ro.mixai.mobile.theme.Mixai

@Composable
fun ConnectScreen(app: LiveApp, onConnected: () -> Unit, onBack: (() -> Unit)?) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val paired by app.store.engines.collectAsState(initial = emptyList())
    val discovery = remember { Discovery(ctx) }
    val found by remember { discovery.engines() }.collectAsState(initial = emptyList())
    val state by app.client.state.collectAsState()
    var link by rememberSaveable { mutableStateOf("") }
    var linkError by rememberSaveable { mutableStateOf(false) }
    var scanning by rememberSaveable { mutableStateOf(false) }
    var cameraDenied by rememberSaveable { mutableStateOf(false) }

    fun use(e: PairedEngine) {
        scope.launch { app.store.save(e) }
        app.client.connect(e)
        onConnected()
    }
    fun tryLink(text: String) {
        val e = Pairing.parse(text)
        if (e == null) linkError = true else { linkError = false; link = ""; use(e) }
    }

    val camPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) scanning = true else cameraDenied = true
    }

    if (scanning) {
        QrScanner(onResult = { text -> scanning = false; tryLink(text) }, onCancel = { scanning = false })
        return
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
                if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.cancel)) }
                Text(stringResource(R.string.connect_title), style = MaterialTheme.typography.headlineMedium)
            }
            Text(stringResource(R.string.connect_hint), style = MaterialTheme.typography.bodyMedium, color = Mixai.colors.muted)
        }
        item {
            Button(
                onClick = {
                    if (ContextCompat.checkSelfPermission(ctx, MainActivity.CAMERA) == PackageManager.PERMISSION_GRANTED) scanning = true
                    else camPerm.launch(MainActivity.CAMERA)
                },
                modifier = Modifier.fillMaxWidth().height(56.dp),
            ) {
                Icon(Icons.Filled.QrCodeScanner, null)
                Spacer(Modifier.padding(4.dp))
                Text(stringResource(R.string.scan_qr))
            }
            if (cameraDenied) Text(stringResource(R.string.camera_denied), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        item { LocalEngineCard(app, onOpen = onConnected) }
        item {
            OutlinedTextField(
                value = link,
                onValueChange = { link = it; linkError = false },
                label = { Text(stringResource(R.string.paste_link)) },
                placeholder = { Text(stringResource(R.string.paste_link_hint)) },
                singleLine = true,
                isError = linkError,
                supportingText = if (linkError) ({ Text(stringResource(R.string.link_invalid)) }) else null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { tryLink(link) }),
                trailingIcon = { TextButton(onClick = { tryLink(link) }, enabled = link.isNotBlank()) { Text(stringResource(R.string.connect)) } },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (paired.isNotEmpty()) {
            item { Text(stringResource(R.string.paired), style = MaterialTheme.typography.titleMedium) }
            items(paired, key = { "p-" + it.key }) { e ->
                val online = found.any { it.host == e.host && it.port == e.port }
                val active = state.engine?.key == e.key && state.phase != Phase.IDLE
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
                    ListItem(
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
                        headlineContent = { Text(e.name) },
                        supportingContent = { Text("${e.host}:${e.port} · ${roleLabel(e.role)}") },
                        leadingContent = { Icon(Icons.Filled.Wifi, null, tint = if (online) Mixai.colors.success else Mixai.colors.muted) },
                        trailingContent = {
                            Row {
                                if (active) {
                                    TextButton(onClick = { app.client.disconnect() }) { Text(stringResource(R.string.disconnect)) }
                                } else {
                                    TextButton(onClick = { use(e) }) { Text(stringResource(R.string.connect)) }
                                }
                                TextButton(onClick = {
                                    if (active) app.client.disconnect()
                                    scope.launch { app.store.remove(e.key) }
                                }) { Text(stringResource(R.string.forget)) }
                            }
                        },
                    )
                }
            }
        }
        item { Text(stringResource(R.string.discovered), style = MaterialTheme.typography.titleMedium) }
        val unpaired = found.filter { d -> paired.none { it.host == d.host && it.port == d.port } }
        if (unpaired.isEmpty()) {
            item { Text(stringResource(if (found.isEmpty()) R.string.discovered_empty else R.string.discovered_needs_token), color = Mixai.colors.muted) }
        } else {
            item { Text(stringResource(R.string.discovered_needs_token), style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted) }
            items(unpaired, key = { "d-" + it.key }) { d ->
                Column(Modifier.fillMaxWidth()) {
                    ListItem(
                        headlineContent = { Text(d.name) },
                        supportingContent = { Text("${d.host}:${d.port}") },
                        leadingContent = { Icon(Icons.Filled.Wifi, null, tint = Mixai.colors.success) },
                        trailingContent = {
                            IconButton(onClick = {
                                if (ContextCompat.checkSelfPermission(ctx, MainActivity.CAMERA) == PackageManager.PERMISSION_GRANTED) scanning = true
                                else camPerm.launch(MainActivity.CAMERA)
                            }) { Icon(Icons.Filled.QrCodeScanner, stringResource(R.string.scan_qr)) }
                        },
                    )
                }
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}
