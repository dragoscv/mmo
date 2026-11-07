package ro.mixai.mobile.onboarding

import android.os.Build
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import ro.mixai.mobile.R
import ro.mixai.mobile.LocalMobileConfig
import ro.mixai.mobile.ui.QrCode
import ro.mixai.tv.data.DiscoveredServer
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.PairRequest
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.discoverServers

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OnboardingScaffold(title: String, onBack: (() -> Unit)?, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    if (onBack != null) IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_action_back))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { pad -> Column(Modifier.padding(pad).fillMaxSize()) { content() } }
}

/** LAN discovery (`_mmo-companion._tcp`) + manual entry. Tapping a server starts Quick Connect pairing. */
@Composable
fun DiscoverScreen(preselected: DiscoveredServer?, onSelect: (DiscoveredServer) -> Unit, onManual: () -> Unit, onBack: (() -> Unit)?) {
    val context = LocalContext.current
    val flow = remember { discoverServers(context.applicationContext).catch { emit(emptyList()) } }
    val found by flow.collectAsState(initial = emptyList())
    val servers = remember(found, preselected) { (listOfNotNull(preselected) + found).distinctBy { it.key } }
    OnboardingScaffold(stringResource(R.string.discover_title), onBack) {
        Text(
            stringResource(R.string.discover_subtitle),
            Modifier.padding(horizontal = 20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.size(12.dp))
        if (servers.isEmpty()) {
            LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 20.dp))
            Text(stringResource(R.string.discover_searching), Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LazyColumn(Modifier.weight(1f)) {
            items(servers, key = { it.key }) { s ->
                ListItem(
                    headlineContent = { Text(s.name.ifBlank { s.host }) },
                    supportingContent = { Text(listOfNotNull("${s.host}:${s.port}", s.version?.let { "v$it" }).joinToString(" · ")) },
                    leadingContent = { Icon(Icons.Filled.Dns, null) },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
                    modifier = Modifier.clickable { onSelect(s) },
                )
            }
            item {
                ListItem(
                    headlineContent = { Text(stringResource(R.string.discover_manual)) },
                    supportingContent = { Text(stringResource(R.string.discover_manual_hint)) },
                    leadingContent = { Icon(Icons.Filled.Edit, null) },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
                    modifier = Modifier.clickable(onClick = onManual),
                )
            }
        }
    }
}

private sealed interface PairState {
    data object Requesting : PairState
    data class Waiting(val req: PairRequest) : PairState
    data object Expired : PairState
    data class Failed(val message: String?) : PairState
}

/**
 * Quick Connect: `POST /pair/request` → 6-digit code; approve it in MixAI on the web / companion
 * (or open `approveUrl` here); polls `/pair/poll` every 3 s.
 */
@Composable
fun PairScreen(server: DiscoveredServer, onPaired: (baseUrl: String, token: String, userId: String) -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    val config = LocalMobileConfig.current
    val api = remember(server.baseUrl) { MmoApi(server.baseUrl, "") }
    var state by remember { mutableStateOf<PairState>(PairState.Requesting) }
    var secondsLeft by remember { mutableIntStateOf(0) }
    var attempt by remember { mutableIntStateOf(0) }
    val deviceName = remember(config) { "${Build.MODEL} · ${config.deviceLabel}" }

    LaunchedEffect(attempt) {
        state = PairState.Requesting
        val req = try { api.pairRequest(deviceName) } catch (e: Exception) {
            state = PairState.Failed(e.message ?: e.javaClass.simpleName); return@LaunchedEffect
        }
        state = PairState.Waiting(req)
        while (true) {
            val left = ((req.expiresAt - System.currentTimeMillis()) / 1000).toInt()
            secondsLeft = left.coerceAtLeast(0)
            if (req.expiresAt > 0 && left <= 0) { state = PairState.Expired; return@LaunchedEffect }
            try {
                val poll = api.pairPoll(req.code, req.secret)
                when (poll.status) {
                    "approved" -> {
                        val token = poll.deviceToken
                        if (token.isNullOrBlank()) state = PairState.Failed(null) else onPaired(server.baseUrl, token, poll.userId ?: "")
                        return@LaunchedEffect
                    }
                    "expired" -> { state = PairState.Expired; return@LaunchedEffect }
                }
            } catch (_: Exception) { /* transient */ }
            delay(3_000)
        }
    }

    OnboardingScaffold(stringResource(R.string.pair_title, server.name.ifBlank { server.host }), onBack) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp).navigationBarsPadding(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("${server.host}:${server.port}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            when (val s = state) {
                PairState.Requesting -> { CircularProgressIndicator(); Text(stringResource(R.string.pair_requesting)) }
                is PairState.Waiting -> {
                    Text(stringResource(R.string.pair_your_code), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(s.req.code.chunked(3).joinToString(" "), fontSize = 44.sp, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.secondary, letterSpacing = 4.sp)
                    Text(stringResource(R.string.pair_instructions), textAlign = TextAlign.Center)
                    val approve = s.req.approveUrl.ifBlank { s.req.qr }
                    if (approve.isNotBlank()) {
                        Button(onClick = { openInBrowser(context, approve) }, Modifier.widthIn(max = 420.dp).fillMaxWidth()) { Text(stringResource(R.string.pair_approve_here)) }
                        QrCode(approve, Modifier.size(180.dp))
                    }
                    Text(
                        if (secondsLeft > 0) stringResource(R.string.signin_expires_in, secondsLeft / 60, secondsLeft % 60) else stringResource(R.string.pair_waiting),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                PairState.Expired -> {
                    Text(stringResource(R.string.pair_expired), color = MaterialTheme.colorScheme.error)
                    Button(onClick = { attempt++ }) { Text(stringResource(R.string.common_action_retry)) }
                }
                is PairState.Failed -> {
                    Text(stringResource(R.string.connect_fail, s.message ?: stringResource(R.string.pair_err_no_token)), color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
                    Text(stringResource(R.string.pair_failed_hint), color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                    Button(onClick = { attempt++ }) { Text(stringResource(R.string.common_action_retry)) }
                }
            }
        }
    }
}

private sealed interface Probe {
    data object Idle : Probe
    data object Busy : Probe
    data class Ok(val version: String, val hostname: String, val pairingSupported: Boolean) : Probe
    data class Fail(val message: String?) : Probe
}

/** Manual URL (+ optional device token). Without a token, offers Quick Connect for that host. */
@Composable
fun ManualServerScreen(onConnected: (base: String, token: String) -> Unit, onQuickConnect: (DiscoveredServer) -> Unit, onBack: () -> Unit) {
    var host by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var probe by remember { mutableStateOf<Probe>(Probe.Idle) }
    val scope = rememberCoroutineScope()

    fun test() {
        val base = Settings.normalizeBaseUrl(host)
        if (base.isEmpty()) { probe = Probe.Fail(null); return }
        probe = Probe.Busy
        scope.launch {
            try {
                val api = MmoApi(base, token.trim())
                val h = api.health()
                val paired = token.isNotBlank() && api.checkToken()
                val supported = runCatching { api.pairInfo().pairingSupported }.getOrDefault(false)
                probe = Probe.Ok(h.version, h.hostname, supported)
                if (paired) onConnected(base, token.trim())
            } catch (e: Exception) {
                probe = Probe.Fail(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    OnboardingScaffold(stringResource(R.string.manual_title), onBack) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            OutlinedTextField(
                value = host, onValueChange = { host = it }, label = { Text(stringResource(R.string.manual_host)) },
                placeholder = { Text(stringResource(R.string.discover_manual_hint)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
            )
            OutlinedTextField(
                value = token, onValueChange = { token = it }, label = { Text(stringResource(R.string.manual_token)) },
                singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { test() }),
            )
            Text(stringResource(R.string.manual_token_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick = { test() }, enabled = probe != Probe.Busy, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.manual_connect)) }
            when (val p = probe) {
                Probe.Idle -> {}
                Probe.Busy -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                is Probe.Fail -> Text(p.message?.let { stringResource(R.string.connect_fail, it) } ?: stringResource(R.string.manual_err_host), color = MaterialTheme.colorScheme.error)
                is Probe.Ok -> Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(R.string.manual_found, p.hostname.ifBlank { host }, p.version))
                        if (p.pairingSupported) {
                            Text(stringResource(R.string.manual_needs_pair), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            OutlinedButton(onClick = {
                                DiscoveredServer.fromBaseUrl(Settings.normalizeBaseUrl(host), p.hostname)?.let(onQuickConnect)
                            }) { Text(stringResource(R.string.manual_quick_connect)) }
                        } else {
                            Text(stringResource(R.string.manual_needs_token), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth()) { Spacer(Modifier.width(1.dp)) }
        }
    }
}
