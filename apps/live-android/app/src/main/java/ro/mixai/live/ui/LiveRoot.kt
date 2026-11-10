package ro.mixai.live.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.LinkOff
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Piano
import androidx.compose.material.icons.filled.Watch
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import ro.mixai.live.LiveApp
import ro.mixai.live.R
import ro.mixai.live.core.ClientState
import ro.mixai.live.core.Pairing
import ro.mixai.live.core.Phase
import ro.mixai.live.core.Role
import ro.mixai.mobile.theme.Mixai

@Composable
fun LiveRoot(app: LiveApp, pendingLink: MutableStateFlow<String?>) {
    val state by app.client.state.collectAsState()
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var showConnect by rememberSaveable { mutableStateOf(false) }

    // Deep link from the QR → pair and connect at once.
    val link by pendingLink.collectAsState()
    LaunchedEffect(link) {
        val e = link?.let { Pairing.parse(it) } ?: return@LaunchedEffect
        pendingLink.value = null
        app.store.save(e)
        app.client.connect(e)
        showConnect = false
    }
    // Auto-connect to the most recent engine on cold start.
    LaunchedEffect(Unit) {
        if (app.client.state.value.phase == Phase.IDLE && link == null) {
            app.store.engines.first().firstOrNull()?.let { app.client.connect(it) }
        }
    }
    // Remember the role + name the engine announced for this pairing.
    LaunchedEffect(state.hello) {
        val h = state.hello ?: return@LaunchedEffect
        val e = state.engine ?: return@LaunchedEffect
        // The phone engine gets fresh tokens on every start: never store it as a paired engine.
        if (e.key == app.local.key) return@LaunchedEffect
        val named = e.copy(role = h.role, name = h.engineName.ifBlank { e.name })
        if (named != e) app.store.save(named)
    }
    val errText = state.lastError?.let { errorText(it.code, it.message) }
    LaunchedEffect(state.lastError) {
        if (errText != null) {
            snackbar.showSnackbar(errText)
            app.client.clearError()
        }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        if (state.phase == Phase.IDLE || showConnect) {
            Box(Modifier.safeDrawingPadding()) {
                ConnectScreen(app = app, onConnected = { showConnect = false }, onBack = if (state.phase != Phase.IDLE) ({ showConnect = false }) else null)
            }
        } else {
            Connected(app, state, snackbar, onSwitch = { showConnect = true }, onWatch = {
                scope.launch {
                    // The phone engine is reachable for the watch only over the LAN, with its performer token.
                    val e = if (state.engine?.key == app.local.key) app.local.lanPairing() else state.engine
                    if (e == null) {
                        snackbar.showSnackbar(app.getString(R.string.local_watch_needs_lan))
                        return@launch
                    }
                    if (app.watch.send(e)) snackbar.showSnackbar(app.getString(R.string.watch_sent))
                }
            })
        }
    }
}

@Composable
private fun Connected(app: LiveApp, state: ClientState, snackbar: SnackbarHostState, onSwitch: () -> Unit, onWatch: () -> Unit) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val view = LocalView.current
    // Haptic tick on every scene change (from any controller, foot switch or MIDI).
    LaunchedEffect(state.sceneChanges) { if (state.sceneChanges > 0) view.tick() }
    val showChain = state.role == Role.CONTROLLER
    if (!showChain && tab >= 2) tab = 0
    Scaffold(
        topBar = { StatusBar(app, state, onSwitch, onWatch) },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(selected = tab == 0, onClick = { tab = 0 }, icon = { Icon(Icons.Filled.Mic, null) }, label = { Text(stringResource(R.string.tab_perform)) })
                NavigationBarItem(selected = tab == 1, onClick = { tab = 1 }, icon = { Icon(Icons.AutoMirrored.Filled.QueueMusic, null) }, label = { Text(stringResource(R.string.tab_setlist)) })
                if (showChain) {
                    NavigationBarItem(selected = tab == 2, onClick = { tab = 2 }, icon = { Icon(Icons.Filled.GraphicEq, null) }, label = { Text(stringResource(R.string.tab_chain)) })
                    NavigationBarItem(selected = tab == 3, onClick = { tab = 3 }, icon = { Icon(Icons.Filled.Piano, null) }, label = { Text(stringResource(R.string.tab_midi)) })
                }
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            when (tab) {
                0 -> PerformScreen(app.client, state)
                1 -> SetlistScreen(app.client, state)
                2 -> ChainScreen(app.client, state)
                else -> MidiScreen(app.client, state)
            }
        }
    }
}

@Composable
private fun StatusBar(app: LiveApp, state: ClientState, onSwitch: () -> Unit, onWatch: () -> Unit) {
    val c = MaterialTheme.colorScheme
    var hasWatch by remember { mutableStateOf(false) }
    LaunchedEffect(state.engine?.key) { hasWatch = app.watch.hasWatch() }
    val (statusText, statusColor) = when (state.phase) {
        Phase.CONNECTED -> stringResource(R.string.status_connected) to Mixai.colors.success
        Phase.CONNECTING -> stringResource(R.string.status_connecting) to Mixai.colors.warning
        Phase.RECONNECTING -> stringResource(R.string.status_reconnecting, state.attempt) to Mixai.colors.warning
        Phase.UNAUTHORIZED -> stringResource(R.string.status_unauthorized) to c.error
        Phase.UPDATE_REQUIRED -> stringResource(R.string.status_update) to c.error
        Phase.IDLE -> stringResource(R.string.status_idle) to Mixai.colors.muted
    }
    Column(Modifier.fillMaxWidth().safeDrawingPadding().padding(horizontal = 12.dp, vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    state.hello?.engineName?.ifBlank { null } ?: state.engine?.name.orEmpty(),
                    style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Pill(roleLabel(state.role), c.secondaryContainer, c.onSecondaryContainer)
                    state.rttMs?.takeIf { state.connected }?.let {
                        Text(stringResource(R.string.rtt, it.toInt()), style = MaterialTheme.typography.labelSmall, color = Mixai.colors.muted)
                    }
                }
            }
            if (hasWatch) IconButton(onClick = onWatch) { Icon(Icons.Filled.Watch, stringResource(R.string.send_to_watch)) }
            IconButton(onClick = onSwitch) { Icon(Icons.Filled.LinkOff, stringResource(R.string.disconnect)) }
        }
        Spacer(Modifier.width(4.dp))
        Text(statusText, style = MaterialTheme.typography.labelMedium, color = statusColor, maxLines = 2)
        if (state.role == Role.VIEWER && state.connected) {
            Text(stringResource(R.string.viewer_hint), style = MaterialTheme.typography.labelSmall, color = Mixai.colors.muted)
        }
    }
}
