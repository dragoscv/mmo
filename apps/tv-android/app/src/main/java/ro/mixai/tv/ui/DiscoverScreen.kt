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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.Card
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import ro.mixai.tv.R
import ro.mixai.tv.data.DiscoveredServer
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.PairInfo
import ro.mixai.tv.data.discoverServers
import ro.mixai.tv.ui.theme.Tokens
import ro.mixai.tv.ui.theme.mixaiCardBorder
import ro.mixai.tv.ui.theme.mixaiCardColors
import ro.mixai.tv.ui.theme.mixaiCardScale

/**
 * Step 1 of Quick Connect: list every MMO Server found on the LAN as a big
 * focusable card. Each card is enriched with `GET /pair/info` (name/version).
 * `preselected` is the previously saved server (health failed) — it is shown
 * first and gets focus even if mDNS has not answered yet.
 */
@Composable
fun DiscoverScreen(
    preselected: DiscoveredServer?,
    onSelect: (DiscoveredServer) -> Unit,
    onManual: () -> Unit,
) {
    val context = LocalContext.current
    var servers by remember { mutableStateOf<List<DiscoveredServer>>(emptyList()) }
    val infos = remember { mutableStateMapOf<String, PairInfo>() }
    val firstFocus = remember { FocusRequester() }
    val manualFocus = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        discoverServers(context).collect { found ->
            servers = buildList {
                if (preselected != null) add(preselected)
                found.forEach { s -> if (none { it.key == s.key }) add(s) }
            }
        }
    }

    // Probe /pair/info on every card once.
    LaunchedEffect(servers.map { it.key }) {
        for (s in servers) if (infos[s.key] == null) {
            try { infos[s.key] = MmoApi(s.baseUrl, "").pairInfo() } catch (_: Exception) {}
        }
    }

    LaunchedEffect(servers.isEmpty()) {
        // Requesters attach after the first layout pass; `requestFocus` throws if called before.
        kotlinx.coroutines.delay(50)
        runCatching { if (servers.isNotEmpty()) firstFocus.requestFocus() else manualFocus.requestFocus() }
    }

    Box(Modifier.fillMaxSize().padding(64.dp), contentAlignment = Alignment.Center) {
        Column(verticalArrangement = Arrangement.spacedBy(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.displaySmall, color = Tokens.foreground)
            Text(
                stringResource(if (servers.isEmpty()) R.string.discover_scanning else R.string.discover_pick),
                style = MaterialTheme.typography.titleMedium, color = Tokens.mutedForeground,
            )
            Spacer(Modifier.height(8.dp))

            if (servers.isNotEmpty()) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    items(servers, key = { it.key }) { s ->
                        val info = infos[s.key]
                        val isFirst = servers.first().key == s.key
                        Card(
                            onClick = { onSelect(s) },
                            modifier = Modifier.width(360.dp).height(180.dp).then(if (isFirst) Modifier.focusRequester(firstFocus) else Modifier),
                            colors = mixaiCardColors(), border = mixaiCardBorder(), scale = mixaiCardScale(),
                        ) {
                            Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.SpaceBetween) {
                                Text(
                                    info?.name?.ifBlank { null } ?: s.name.ifBlank { stringResource(R.string.common_saved_server) },
                                    style = MaterialTheme.typography.headlineSmall, color = Tokens.foreground,
                                )
                                Column {
                                    Text("${s.host}:${s.port}", color = Tokens.mutedForeground)
                                    Text(
                                        when {
                                            info == null -> stringResource(R.string.common_mmo_server)
                                            !info.pairingSupported -> stringResource(R.string.discover_no_pairing, info.version)
                                            else -> stringResource(R.string.discover_quick, info.version)
                                        },
                                        color = if (info != null && !info.pairingSupported) Tokens.warning else Tokens.brandCyanDark,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Button(onClick = onManual, modifier = Modifier.focusRequester(manualFocus)) { Text(stringResource(R.string.discover_manual)) }
            }
        }
    }
}
