package ro.mixai.live.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import ro.mixai.live.R
import ro.mixai.live.core.ClientMsg
import ro.mixai.live.core.ClientState
import ro.mixai.live.core.FxParamSpec
import ro.mixai.live.core.FxSpec
import ro.mixai.live.core.InsertState
import ro.mixai.live.core.LiveClient
import ro.mixai.live.core.Role
import ro.mixai.mobile.theme.Mixai
import java.util.Locale

/** Controller role: inserts with enable toggles and their parameters (specs from GET /api/fx; log curves via norm). */
@Composable
fun ChainScreen(client: LiveClient, state: ClientState) {
    if (!state.can(Role.CONTROLLER)) {
        Text(stringResource(R.string.chain_controller_only), Modifier.padding(24.dp), color = Mixai.colors.muted)
        return
    }
    var specs by remember { mutableStateOf<Map<String, FxSpec>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(state.engine?.key, reload) {
        failed = false
        specs = runCatching { client.fetchFx().associateBy { it.id } }.onFailure { failed = true }.getOrNull()
    }
    val chain = state.session?.chain.orEmpty()
    when {
        failed -> Column(Modifier.padding(24.dp)) {
            Text(stringResource(R.string.fx_failed), color = MaterialTheme.colorScheme.error)
            Button(onClick = { reload++ }) { Text(stringResource(R.string.retry)) }
        }
        specs == null -> Text(stringResource(R.string.fx_loading), Modifier.padding(24.dp), color = Mixai.colors.muted)
        chain.isEmpty() -> Text(stringResource(R.string.chain_empty), Modifier.padding(24.dp), color = Mixai.colors.muted)
        else -> LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(chain, key = { it.id }) { ins -> InsertCard(client, ins, specs!![ins.fx]) }
        }
    }
}

@Composable
private fun InsertCard(client: LiveClient, ins: InsertState, spec: FxSpec?) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val name = ins.fx.replace('_', ' ').replaceFirstChar { it.titlecase(Locale.ROOT) }
                val enabledLabel = stringResource(R.string.enabled)
                Text(name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Switch(
                    checked = ins.enabled,
                    onCheckedChange = { client.send(ClientMsg.SetEnabled(ins.id, it)) },
                    modifier = Modifier.semantics { contentDescription = "$name, $enabledLabel" },
                )
            }
            val params = spec?.params ?: ins.params.map { FxParamSpec(it.first) }
            params.forEach { p ->
                val v = ins.param(p.id) ?: p.default
                ParamControl(client, ins.id, p, v)
            }
        }
    }
}

@Composable
private fun ParamControl(client: LiveClient, insert: Int, p: FxParamSpec, value: Float) {
    val label = p.id.replace('_', ' ')
    when {
        p.isToggle -> Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
            Switch(checked = value >= 0.5f, onCheckedChange = { client.send(ClientMsg.SetParam(insert, p.id, if (it) 1f else 0f)) })
        }
        p.isChoice && p.choices.isNotEmpty() -> Column {
            Text(label, style = MaterialTheme.typography.labelLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                p.choices.forEachIndexed { i, c ->
                    FilterChip(selected = Math.round(value) == i, onClick = { client.send(ClientMsg.SetParam(insert, p.id, i.toFloat())) }, label = { Text(c) })
                }
            }
        }
        else -> EngineSlider(
            label = label,
            engineValue = p.toNorm(value),
            range = 0f..1f,
            format = { n -> formatParam(p, p.fromNorm(n)) },
            enabled = true,
            onSend = { n -> client.send(ClientMsg.SetParamNorm(insert, p.id, n)) },
        )
    }
}

private fun formatParam(p: FxParamSpec, v: Float): String = when (p.unit) {
    "db" -> String.format(Locale.ROOT, "%.1f dB", v)
    "hz" -> if (v >= 1000f) String.format(Locale.ROOT, "%.2f kHz", v / 1000f) else String.format(Locale.ROOT, "%.0f Hz", v)
    "ms" -> String.format(Locale.ROOT, "%.0f ms", v)
    "seconds" -> String.format(Locale.ROOT, "%.2f s", v)
    "percent" -> String.format(Locale.ROOT, "%.0f %%", v)
    "ratio" -> String.format(Locale.ROOT, "%.1f:1", v)
    "semitones" -> String.format(Locale.ROOT, "%+.1f st", v)
    "cents" -> String.format(Locale.ROOT, "%+.0f ct", v)
    "bpm" -> String.format(Locale.ROOT, "%.1f BPM", v)
    else -> String.format(Locale.ROOT, "%.2f", v)
}
