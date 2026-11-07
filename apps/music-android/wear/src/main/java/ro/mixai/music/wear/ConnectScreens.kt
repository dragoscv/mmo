package ro.mixai.music.wear

import android.content.Intent
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.input.RemoteInputIntentHelper
import androidx.wear.input.wearableExtender
import android.app.RemoteInput
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flowOf
import ro.mixai.tv.data.DiscoveredServer
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.PairRequest
import ro.mixai.tv.data.Settings
import ro.mixai.tv.data.discoverServers

/** Pick a server: from the phone (Data Layer), mDNS on the watch's network, or typed. */
@Composable
fun ServerPickScreen(
    phoneOffer: ro.mixai.tv.data.WearHandoff.Payload?,
    onUsePhone: () -> Unit,
    onPick: (DiscoveredServer) -> Unit,
) {
    val context = LocalContext.current
    val servers by remember { runCatching { discoverServers(context) }.getOrElse { flowOf(emptyList()) } }.collectAsState(initial = emptyList())
    val state = rememberTransformingLazyColumnState()
    val urlInput = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val text = r.data?.let { RemoteInput.getResultsFromIntent(it)?.getCharSequence(KEY_URL)?.toString() }.orEmpty().trim()
        if (text.isNotBlank()) DiscoveredServer.fromBaseUrl(Settings.normalizeBaseUrl(text))?.let(onPick)
    }
    ScreenScaffold(scrollState = state) { padding ->
        TransformingLazyColumn(state = state, contentPadding = padding) {
            item { ListHeader { Text(stringResource(R.string.connect_title)) } }
            if (phoneOffer != null) {
                item {
                    Button(onClick = onUsePhone, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.connect_from_phone)) },
                        secondaryLabel = { Text(phoneOffer.baseUrl.removePrefix("https://").removePrefix("http://"), maxLines = 1) })
                }
            }
            if (servers.isEmpty()) {
                item { Text(stringResource(R.string.connect_searching), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
            }
            servers.forEach { s ->
                item(key = s.key) {
                    FilledTonalButton(onClick = { onPick(s) }, modifier = Modifier.fillMaxWidth(), label = { Text(s.name, maxLines = 1) },
                        secondaryLabel = { Text("${s.host}:${s.port}", maxLines = 1) })
                }
            }
            item {
                FilledTonalButton(onClick = {
                    val ri = RemoteInput.Builder(KEY_URL).setLabel(context.getString(R.string.connect_manual_hint))
                        .wearableExtender { setEmojisAllowed(false); setInputActionType(android.view.inputmethod.EditorInfo.IME_ACTION_DONE) }.build()
                    val intent: Intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
                    RemoteInputIntentHelper.putRemoteInputsExtra(intent, listOf(ri))
                    urlInput.launch(intent)
                }, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.connect_manual)) })
            }
        }
    }
}

private const val KEY_URL = "server_url"

private sealed interface PairUi {
    data object Requesting : PairUi
    data class Waiting(val req: PairRequest) : PairUi
    data object Expired : PairUi
    data class Failed(val message: String) : PairUi
}

/** Quick Connect on the watch: shows the code; approve it in MixAI Music on the phone, the web or the companion. */
@Composable
fun WearPairScreen(server: DiscoveredServer, onPaired: (baseUrl: String, token: String, userId: String) -> Unit) {
    val api = remember(server.baseUrl) { MmoApi(server.baseUrl, "") }
    var ui by remember { mutableStateOf<PairUi>(PairUi.Requesting) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(attempt) {
        ui = PairUi.Requesting
        val req = try { api.pairRequest("${Build.MODEL} · MixAI Music") } catch (e: Exception) {
            ui = PairUi.Failed(e.message ?: e.javaClass.simpleName); return@LaunchedEffect
        }
        ui = PairUi.Waiting(req)
        while (true) {
            if (req.expiresAt > 0 && req.expiresAt <= System.currentTimeMillis()) { ui = PairUi.Expired; return@LaunchedEffect }
            val poll = runCatching { api.pairPoll(req.code, req.secret) }.getOrNull()
            when (poll?.status) {
                "approved" -> {
                    val t = poll.deviceToken
                    if (t.isNullOrBlank()) ui = PairUi.Failed("no token") else onPaired(server.baseUrl, t, poll.userId.orEmpty())
                    return@LaunchedEffect
                }
                "expired" -> { ui = PairUi.Expired; return@LaunchedEffect }
            }
            delay(3_000)
        }
    }
    ScreenScaffold {
        Column(
            Modifier.fillMaxSize().padding(horizontal = 18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
        ) {
            when (val s = ui) {
                PairUi.Requesting -> CircularProgressIndicator()
                is PairUi.Waiting -> {
                    Text(stringResource(R.string.pair_code), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(s.req.code.chunked(3).joinToString(" "), fontSize = 30.sp, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.secondary)
                    Text(stringResource(R.string.pair_hint), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
                }
                PairUi.Expired -> {
                    Text(stringResource(R.string.pair_expired), textAlign = TextAlign.Center)
                    Button(onClick = { attempt++ }, label = { Text(stringResource(R.string.action_retry)) })
                }
                is PairUi.Failed -> {
                    Text(stringResource(R.string.pair_failed, s.message), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, maxLines = 4)
                    Button(onClick = { attempt++ }, label = { Text(stringResource(R.string.action_retry)) })
                }
            }
        }
    }
}
