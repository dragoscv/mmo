package ro.mixai.music.ui.output

import android.annotation.SuppressLint
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Cast
import androidx.compose.material.icons.outlined.CastConnected
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Speaker
import androidx.compose.material.icons.outlined.Tv
import androidx.compose.material.icons.outlined.VolumeUp
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ro.mixai.music.ui.MusicDeps
import ro.mixai.music.ui.R
import ro.mixai.tv.cast.MusicOutputs
import ro.mixai.tv.cast.OutputTarget

private fun iconFor(t: OutputTarget): ImageVector = when (t) {
    OutputTarget.Local -> Icons.Outlined.PhoneAndroid
    is OutputTarget.Cast -> Icons.Outlined.Cast
    is OutputTarget.HubTv -> Icons.Outlined.Tv
    is OutputTarget.Dlna -> Icons.Outlined.Speaker
    is OutputTarget.HomeAssistant -> Icons.Outlined.Home
}

@Composable
private fun kindLabel(t: OutputTarget): String = stringResource(
    when (t) {
        OutputTarget.Local -> R.string.output_kind_local
        is OutputTarget.Cast -> R.string.output_kind_cast
        is OutputTarget.HubTv -> R.string.output_kind_tv
        is OutputTarget.Dlna -> R.string.output_kind_dlna
        is OutputTarget.HomeAssistant -> R.string.output_kind_ha
    },
)

@Composable
fun outputName(t: OutputTarget): String = if (t is OutputTarget.Local) stringResource(R.string.output_this_device) else t.name

/** Output button for Now Playing: shows the active output, opens [OutputSheet]. */
@Composable
fun OutputButton(deps: MusicDeps) {
    val ctl = deps.outputs ?: return
    val active by MusicOutputs.active.collectAsState()
    val switching by MusicOutputs.switching.collectAsState()
    var open by remember { mutableStateOf(false) }
    val label = stringResource(R.string.output_pick)
    IconButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = label }) {
        when {
            switching != null -> CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
            active is OutputTarget.Local -> Icon(Icons.Outlined.Cast, contentDescription = null)
            else -> Icon(Icons.Outlined.CastConnected, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        }
    }
    if (open) OutputSheet(deps, ctl) { open = false }
}

/** "Playing on X" / "Continue on X" line under the controls. */
@Composable
fun OutputStatus(deps: MusicDeps) {
    val ctl = deps.outputs ?: return
    val active by MusicOutputs.active.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var last by remember(active) { mutableStateOf(ctl.last()) }
    LaunchedEffect(Unit) {
        MusicOutputs.failures.collect { f ->
            Toast.makeText(context, context.getString(R.string.output_lost, f.target.name.ifBlank { "?" }), Toast.LENGTH_LONG).show()
        }
    }
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.Center) {
        if (active !is OutputTarget.Local) {
            AssistChip(
                onClick = { ctl.select(OutputTarget.Local) },
                label = { Text(stringResource(R.string.output_playing_on, active.name)) },
                leadingIcon = { Icon(iconFor(active), contentDescription = null, Modifier.size(AssistChipDefaults.IconSize)) },
                trailingIcon = { Icon(Icons.Outlined.PhoneAndroid, contentDescription = stringResource(R.string.output_back_here), Modifier.size(AssistChipDefaults.IconSize)) },
            )
        } else last?.let { e ->
            AssistChip(
                onClick = {
                    scope.launch {
                        if (!ctl.reconnect(e)) {
                            Toast.makeText(context, context.getString(R.string.output_not_found, e.name), Toast.LENGTH_SHORT).show()
                            last = null
                        }
                    }
                },
                label = { Text(stringResource(R.string.output_continue_on, e.name)) },
                leadingIcon = { Icon(Icons.Outlined.Cast, contentDescription = null, Modifier.size(AssistChipDefaults.IconSize)) },
            )
        }
    }
}

@SuppressLint("UnsafeOptInUsageError")
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OutputSheet(deps: MusicDeps, ctl: OutputController, onDismiss: () -> Unit) {
    val active by MusicOutputs.active.collectAsState()
    val switching by MusicOutputs.switching.collectAsState()
    val castRoutes by CastOutputs.routes.collectAsState()
    val others by ctl.targets.collectAsState()
    val scanning by ctl.scanning.collectAsState()
    val state by deps.musicPlayback.state.collectAsState()

    DisposableEffect(Unit) {
        if (ctl.castEnabled) CastOutputs.scan(true)
        ctl.scan()
        onDispose { if (ctl.castEnabled) CastOutputs.scan(false) }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 16.dp).verticalScroll(rememberScrollState())) {
            Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.output_title), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                if (scanning) CircularProgressIndicator(Modifier.size(20.dp).padding(end = 4.dp), strokeWidth = 2.dp)
                else IconButton(onClick = { ctl.scan() }) { Icon(Icons.Outlined.Refresh, contentDescription = stringResource(R.string.output_refresh)) }
            }
            state.remoteVolume?.let { v -> RemoteVolume(v, state.remoteVolumeMax) { deps.musicPlayback.setRemoteVolume(it) } }

            val pick: (OutputTarget) -> Unit = { t -> ctl.select(t); if (t is OutputTarget.Local || t !is OutputTarget.Cast) onDismiss() }
            OutputRow(OutputTarget.Local, active, switching, pick)
            val all = ((if (ctl.castEnabled) castRoutes else emptyList()) + others).distinctBy { it.id }
            if (all.isEmpty() && !scanning) {
                Text(
                    stringResource(R.string.output_none),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp),
                )
            }
            listOf<Pair<Int, List<OutputTarget>>>(
                R.string.output_group_tv to all.filterIsInstance<OutputTarget.HubTv>(),
                R.string.output_group_cast to all.filterIsInstance<OutputTarget.Cast>(),
                R.string.output_group_dlna to all.filterIsInstance<OutputTarget.Dlna>(),
                R.string.output_group_ha to all.filterIsInstance<OutputTarget.HomeAssistant>(),
            ).filter { it.second.isNotEmpty() }.forEach { (title, list) ->
                HorizontalDivider(Modifier.padding(vertical = 4.dp))
                Text(
                    stringResource(title), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
                )
                list.forEach { OutputRow(it, active, switching, pick) }
            }
            Text(
                stringResource(R.string.output_note),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp),
            )
        }
    }
}

@Composable
private fun OutputRow(t: OutputTarget, active: OutputTarget, switching: OutputTarget?, onPick: (OutputTarget) -> Unit) {
    val selected = t.id == active.id
    val busy = switching?.id == t.id
    ListItem(
        headlineContent = { Text(outputName(t)) },
        supportingContent = { Text(kindLabel(t)) },
        leadingContent = { Icon(iconFor(t), contentDescription = null, tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) },
        trailingContent = {
            when {
                busy -> CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                selected -> Icon(Icons.Outlined.Check, contentDescription = stringResource(R.string.output_selected), tint = MaterialTheme.colorScheme.primary)
            }
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow.copy(alpha = 0f)),
        modifier = Modifier.clickable(enabled = !selected && switching == null, role = Role.RadioButton) { onPick(t) },
    )
}

@Composable
private fun RemoteVolume(level: Int, max: Int, onChange: (Int) -> Unit) {
    var dragging by remember { mutableStateOf(false) }
    var value by remember { mutableFloatStateOf(level.toFloat()) }
    if (!dragging) value = level.toFloat()
    val label = stringResource(R.string.output_volume)
    Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.VolumeUp, contentDescription = null)
        Slider(
            value = value,
            onValueChange = { dragging = true; value = it },
            onValueChangeFinished = { onChange(value.toInt()); dragging = false },
            valueRange = 0f..max.toFloat(),
            modifier = Modifier.weight(1f).padding(start = 12.dp).semantics { contentDescription = label },
        )
    }
}
