package ro.mixai.live.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import ro.mixai.live.LiveApp
import ro.mixai.live.R
import ro.mixai.live.ffi.liveReason
import ro.mixai.mobile.theme.Mixai

/**
 * "This phone as the engine" (WP21-06): starts the native engine on the device and connects the app to it over
 * 127.0.0.1, so every screen works without a computer. Also measures the real round trip (speaker → mic or cable).
 */
@Composable
fun LocalEngineCard(app: LiveApp, onOpen: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val engine by app.local.engine.collectAsState()
    val stoppedReason by app.local.lastError.collectAsState()
    var lan by rememberSaveable { mutableStateOf(false) }
    var busy by rememberSaveable { mutableStateOf(false) }
    var message by rememberSaveable { mutableStateOf<String?>(null) }
    var isError by rememberSaveable { mutableStateOf(false) }
    val c = MaterialTheme.colorScheme

    fun start() {
        busy = true
        message = null
        scope.launch {
            app.local.start(lan)
                .onSuccess { busy = false; onOpen() }
                .onFailure { busy = false; isError = true; message = ctx.getString(R.string.local_failed, it.liveReason()) }
        }
    }
    val notifPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { start() }
    val micPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (!ok) {
            isError = true
            message = ctx.getString(R.string.mic_denied)
        } else if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notifPerm.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            start()
        }
    }

    Card(colors = CardDefaults.cardColors(containerColor = c.surfaceContainerHigh)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.PhoneAndroid, null, tint = if (engine != null) Mixai.colors.success else c.onSurfaceVariant)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.local_title), style = MaterialTheme.typography.titleMedium)
            }
            val e = engine
            if (e == null) {
                Text(stringResource(R.string.local_hint), style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted)
                stoppedReason?.let {
                    Text(stringResource(R.string.local_failed, it), style = MaterialTheme.typography.bodySmall, color = c.error)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.local_lan), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    Switch(checked = lan, onCheckedChange = { lan = it }, enabled = !busy)
                }
                Button(
                    // Already granted: the launcher answers at once without a dialog.
                    onClick = { micPerm.launch(Manifest.permission.RECORD_AUDIO) },
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(stringResource(if (busy) R.string.local_starting else R.string.local_start)) }
            } else {
                val r = e.ready
                Text(
                    stringResource(R.string.local_running, r.input, r.sampleRate.toInt(), r.bufferFrames.toInt()),
                    style = MaterialTheme.typography.bodySmall,
                    color = Mixai.colors.success,
                    modifier = Modifier.semantics { stateDescription = ctx.getString(R.string.status_connected) },
                )
                if (r.lanHost != r.localHost) {
                    Text(stringResource(R.string.local_lan_at, r.lanHost, r.port.toInt()), style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted)
                    // Performer token: other devices can perform (scenes, mix, panic), not rebuild the chain.
                    PairingQr(r.performerUrl, stringResource(R.string.local_qr), Modifier.size(180.dp))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = {
                        if (app.client.state.value.engine?.key != e.paired.key) app.client.connect(e.paired)
                        onOpen()
                    }) { Text(stringResource(R.string.local_open)) }
                    OutlinedButton(enabled = !busy, onClick = {
                        busy = true
                        isError = false
                        message = ctx.getString(R.string.local_latency_running)
                        scope.launch {
                            app.local.measureLatency()
                                .onSuccess {
                                    busy = false
                                    message = ctx.getString(R.string.local_latency_result, it.roundTripMs, it.nominalMs)
                                }
                                .onFailure {
                                    busy = false
                                    isError = true
                                    message = ctx.getString(R.string.local_latency_failed, it.liveReason())
                                }
                        }
                    }) { Text(stringResource(R.string.local_latency)) }
                    TextButton(onClick = { app.local.stop(); message = null }) { Text(stringResource(R.string.local_stop)) }
                }
            }
            message?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = if (isError) c.error else c.onSurface)
            }
        }
    }
}
