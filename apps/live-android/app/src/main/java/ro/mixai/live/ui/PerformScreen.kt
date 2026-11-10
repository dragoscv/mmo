package ro.mixai.live.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role as SemRole
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import ro.mixai.live.R
import ro.mixai.live.core.ClientMsg
import ro.mixai.live.core.ClientState
import ro.mixai.live.core.LiveClient
import ro.mixai.live.core.Role
import ro.mixai.live.core.SessionState
import ro.mixai.mobile.theme.Mixai

@Composable
fun PerformScreen(client: LiveClient, state: ClientState) {
    val s = state.session
    val mix = s?.mix
    val levels = rememberMeterLevels(client.meters)
    val canPerform = state.can(Role.PERFORMER)
    val view = LocalView.current
    var panicked by remember { mutableStateOf(false) }
    // Raw format strings (no args) so the slider formatters stay plain lambdas.
    val dbFmt = stringResource(R.string.db_value)
    val pctFmt = stringResource(R.string.percent_value)
    val fmtDb: (Float) -> String = { String.format(java.util.Locale.getDefault(), dbFmt, it) }
    val fmtPct: (Float) -> String = { String.format(java.util.Locale.getDefault(), pctFmt, Math.round(it * 100)) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Song / part header
        val song = s?.currentSong
        val part = s?.currentPart
        Column {
            Text(
                part?.name ?: s?.preset.orEmpty().ifBlank { "—" },
                style = MaterialTheme.typography.displaySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (song != null) Text(song.title, style = MaterialTheme.typography.titleMedium, color = Mixai.colors.muted, maxLines = 1)
                s?.bpm?.let { Text(stringResource(R.string.bpm_value, it), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.secondary) }
            }
        }

        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MeterBars(levels, Modifier.weight(1f))
            ClipLamp(levels)
        }
        EngineHealth(client.meters)
        TunerView(client.meters, levels)

        if (canPerform) {
            // Scenes: the biggest targets on the screen.
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                FilledTonalButton(
                    onClick = { client.send(ClientMsg.Prev) },
                    modifier = Modifier.weight(1f).height(96.dp),
                    shape = RoundedCornerShape(20.dp),
                ) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, null)
                    Text(stringResource(R.string.prev_scene), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 6.dp))
                }
                Button(
                    onClick = { client.send(ClientMsg.Next) },
                    modifier = Modifier.weight(1f).height(96.dp),
                    shape = RoundedCornerShape(20.dp),
                ) {
                    Text(stringResource(R.string.next_scene), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(end = 6.dp))
                    Icon(Icons.AutoMirrored.Filled.ArrowForward, null)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ToggleBig(stringResource(R.string.mute), mix?.mute == true, MaterialTheme.colorScheme.error, Modifier.weight(1f)) {
                    panicked = false
                    client.send(ClientMsg.SetMix(mute = !(mix?.mute ?: false)))
                }
                ToggleBig(stringResource(R.string.bypass), mix?.bypass == true, Mixai.colors.warning, Modifier.weight(1f)) {
                    client.send(ClientMsg.SetMix(bypass = !(mix?.bypass ?: false)))
                }
                FilledTonalButton(
                    onClick = { view.tick(); client.send(ClientMsg.TapTempo) },
                    modifier = Modifier.weight(1f).height(64.dp),
                    shape = RoundedCornerShape(16.dp),
                ) { Text(stringResource(R.string.tap), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold) }
            }
            PanicButton(onFire = {
                view.tick(strong = true)
                panicked = true
                client.send(ClientMsg.Panic)
            })
            if (panicked) Text(stringResource(R.string.panic_sent), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)

            // Mix
            if (mix != null) {
                EngineSlider(stringResource(R.string.input_gain), mix.inputDb, -24f..12f, fmtDb, true, { client.send(ClientMsg.SetMix(inputDb = round1(it))) })
                EngineSlider(stringResource(R.string.main_level), mix.mainDb, -60f..12f, fmtDb, true, { client.send(ClientMsg.SetMix(mainDb = round1(it))) })
                EngineSlider(stringResource(R.string.monitor_level), mix.monitorDb, -60f..12f, fmtDb, true, { client.send(ClientMsg.SetMix(monitorDb = round1(it))) })
                EngineSlider(
                    stringResource(R.string.monitor_dry), mix.monitorDry, 0f..1f,
                    fmtPct, true, { client.send(ClientMsg.SetMix(monitorDry = it)) },
                )
            }

            // Presets
            if (!s?.presets.isNullOrEmpty()) PresetRow(client, state, s)
        } else if (mix != null) {
            // Viewer: state only.
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (mix.mute) Pill(stringResource(R.string.mute), MaterialTheme.colorScheme.error, MaterialTheme.colorScheme.onError)
                if (mix.bypass) Pill(stringResource(R.string.bypass), Mixai.colors.warning, MaterialTheme.colorScheme.background)
                Text(s.preset, style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}

private fun round1(v: Float) = Math.round(v * 2f) / 2f

/**
 * Presets, with (controller role) delete for user presets and revert for a factory preset a user copy overrides.
 * The engine answers `factory_preset` when an untouched factory preset is deleted, so revert is always offered for
 * them and the engine stays the judge.
 */
@Composable
private fun PresetRow(client: LiveClient, state: ClientState, s: SessionState) {
    val canEdit = state.can(Role.CONTROLLER)
    var pending by remember { mutableStateOf<String?>(null) }
    Text(stringResource(R.string.presets), style = MaterialTheme.typography.titleMedium)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        s.presets.forEach { p ->
            val factory = s.isFactoryPreset(p)
            val removable = !factory || p in s.modifiedPresets
            val editIcon: (@Composable () -> Unit)? = if (!canEdit || !removable) null else {
                {
                    val desc = stringResource(if (factory) R.string.preset_revert else R.string.preset_delete, p)
                    Icon(
                        if (factory) Icons.Filled.Restore else Icons.Filled.DeleteOutline,
                        desc,
                        Modifier.size(18.dp).clickable(onClickLabel = desc) { pending = p },
                    )
                }
            }
            FilterChip(
                selected = p == s.preset,
                onClick = { client.send(ClientMsg.LoadPreset(p)) },
                label = { Text(p) },
                trailingIcon = editIcon,
            )
        }
    }
    val name = pending
    if (name != null) {
        val factory = s.isFactoryPreset(name)
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text(stringResource(if (factory) R.string.preset_revert_title else R.string.preset_delete_title)) },
            text = { Text(stringResource(if (factory) R.string.preset_revert_body else R.string.preset_delete_body, name)) },
            confirmButton = {
                TextButton(onClick = { pending = null; client.send(ClientMsg.DeletePreset(name)) }) {
                    Text(stringResource(if (factory) R.string.preset_revert_confirm else R.string.preset_delete_confirm))
                }
            },
            dismissButton = { TextButton(onClick = { pending = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun ToggleBig(label: String, on: Boolean, onColor: androidx.compose.ui.graphics.Color, modifier: Modifier, onClick: () -> Unit) {
    val colors = if (on) ButtonDefaults.buttonColors(containerColor = onColor, contentColor = MaterialTheme.colorScheme.background)
    else ButtonDefaults.filledTonalButtonColors()
    Button(onClick = onClick, colors = colors, modifier = modifier.height(64.dp), shape = RoundedCornerShape(16.dp)) {
        Text(label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
    }
}

/** Hold 1 s to fire (an accidental tap must never mute a show). Progress fill drawn in the draw phase. */
@Composable
private fun PanicButton(onFire: () -> Unit) {
    val scope = rememberCoroutineScope()
    val progress = remember { mutableFloatStateOf(0f) }
    var job by remember { mutableStateOf<Job?>(null) }
    val bg = MaterialTheme.colorScheme.error.copy(alpha = 0.25f)
    val fill = MaterialTheme.colorScheme.error
    val label = stringResource(R.string.panic)
    val hint = stringResource(R.string.panic_hold)
    LaunchedEffect(Unit) { progress.floatValue = 0f }
    Box(
        Modifier
            .fillMaxWidth()
            .height(72.dp)
            .background(bg, RoundedCornerShape(18.dp))
            .drawBehind {
                val w = size.width * progress.floatValue
                if (w > 0f) drawRoundRect(fill, size = Size(w, size.height), cornerRadius = androidx.compose.ui.geometry.CornerRadius(18.dp.toPx()))
            }
            .semantics {
                role = SemRole.Button
                contentDescription = "$label, $hint"
                // Accessibility services fire it directly (they cannot hold).
                onClick { onFire(); true }
            }
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown()
                    job?.cancel()
                    job = scope.launch {
                        val start = System.nanoTime()
                        while (isActive) {
                            val p = ((System.nanoTime() - start) / 1e9f).coerceIn(0f, 1f)
                            progress.floatValue = p
                            if (p >= 1f) { onFire(); break }
                            delay(16)
                        }
                    }
                    waitForUpOrCancellation()
                    job?.cancel()
                    progress.floatValue = 0f
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface)
            Text(hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurface)
        }
    }
}
