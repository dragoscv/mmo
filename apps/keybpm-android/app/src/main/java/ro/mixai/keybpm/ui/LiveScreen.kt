package ro.mixai.keybpm.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ro.mixai.keybpm.ListenUi
import ro.mixai.keybpm.R
import ro.mixai.mobile.theme.Mixai
import uniffi.mixai_listen_ffi.KeyNotation
import uniffi.mixai_listen_ffi.compatibleKeys
import uniffi.mixai_listen_ffi.keyLabel
import kotlin.math.roundToInt

@Composable
fun LiveScreen(
    ui: ListenUi,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onAgain: () -> Unit,
    onCycleTempo: () -> Unit,
    onNotation: (KeyNotation) -> Unit,
    onPickFile: () -> Unit,
    onSave: () -> Unit,
    onStage: () -> Unit = {},
    onIdentify: () -> Unit = {},
    onTracklist: (Boolean) -> Unit = {},
    onAddToQueue: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val s = ui.snapshot
    val key = s?.key
    val tempo = s?.tempo
    // Beat pulse: kick to 1 on each predicted beat, decay over 180 ms (no animation with reduced motion).
    val pulse = remember { Animatable(0f) }
    val view = LocalView.current
    val reduced = remember(view) {
        android.provider.Settings.Global.getFloat(view.context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    LaunchedEffect(tempo?.locked, tempo?.bpm, ui.listening) {
        if (tempo == null || !ui.listening || reduced) return@LaunchedEffect
        val period = (60_000.0 / (tempo.bpm * ui.tempoFactor)).toLong().coerceIn(200, 2000)
        kotlinx.coroutines.delay((tempo.nextBeatInSecs * 1000).toLong().coerceIn(0, period))
        while (true) {
            pulse.snapTo(1f)
            pulse.animateTo(0f, tween(180))
            kotlinx.coroutines.delay((period - 180).coerceAtLeast(20))
        }
    }
    val compatible = remember(key?.key?.index) {
        key?.key?.index?.let { idx -> compatibleKeys(idx).map { it.key.camelot }.toSet() } ?: emptySet()
    }
    val keyText = key?.let { keyLabel(it.key.index, ui.notation) } ?: "—"
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        ui.fileName?.let {
            Text(stringResource(R.string.file_header, it), style = MaterialTheme.typography.titleSmall, color = Mixai.colors.muted)
            Spacer(Modifier.height(8.dp))
        }
        CamelotWheel(
            camelotNumber = key?.key?.camelotNumber?.toInt(),
            minor = key?.key?.minor == true,
            compatible = compatible,
            beatPulse = pulse.value,
            label = stringResource(R.string.cd_wheel, keyText),
            modifier = Modifier.fillMaxWidth().widthIn(max = 420.dp),
        )
        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            Readout(
                label = stringResource(R.string.key_label),
                value = keyText,
                detail = key?.let {
                    val state = stringResource(if (it.locked) R.string.locked else R.string.provisional)
                    "$state · " + stringResource(R.string.confidence, (it.confidence * 100).roundToInt())
                },
                sub = key?.let { stringResource(R.string.alternative, keyLabel(it.alternative.index, ui.notation)) + " · " + it.key.name },
            )
            Readout(
                label = stringResource(R.string.bpm_label),
                value = tempo?.let { "%.1f".format(it.bpm * ui.tempoFactor) } ?: "—",
                detail = tempo?.let {
                    val state = stringResource(if (it.locked) R.string.locked else R.string.provisional)
                    "$state · " + stringResource(R.string.confidence, (it.confidence * 100).roundToInt())
                },
                sub = null,
                onClick = if (tempo != null) onCycleTempo else null,
                badge = when (ui.tempoFactor) { 0.5 -> stringResource(R.string.half_tempo); 2.0 -> stringResource(R.string.double_tempo); else -> null },
            )
        }
        Spacer(Modifier.height(12.dp))
        ui.keyChange?.let {
            Text(
                stringResource(R.string.key_changed, it),
                color = Mixai.colors.warning,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
            )
            Spacer(Modifier.height(8.dp))
        }
        if (s != null) {
            DetailRow(stringResource(R.string.chord_label), s.chord?.label ?: stringResource(R.string.no_chord))
            DetailRow(
                stringResource(R.string.tuning_label),
                stringResource(R.string.tuning_value, s.tuningA4Hz, s.tuningCents.roundToInt()),
            )
            s.energy?.let { DetailRow(stringResource(R.string.energy_label), "%.1f / 10".format(it)) }
            s.loudness?.shortTermLufs?.takeIf { it.isFinite() }?.let { DetailRow(stringResource(R.string.loudness_label), stringResource(R.string.lufs_value, it)) }
            if (s.levelDbfs < -55 && ui.listening) {
                Text(stringResource(R.string.level_low), color = Mixai.colors.muted, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(8.dp))
            ChromaStrip(s.chroma)
        } else if (ui.analysing) {
            Text(stringResource(R.string.analysing), color = Mixai.colors.muted)
            LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
        } else if (ui.fileError) {
            Text(stringResource(R.string.file_error), color = MaterialTheme.colorScheme.error)
        } else {
            Text(
                stringResource(if (ui.listening) R.string.listening else R.string.idle_hint),
                color = Mixai.colors.muted,
                style = MaterialTheme.typography.bodyMedium,
            )
            if (ui.listening) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((n, label) in listOf(
                KeyNotation.CAMELOT to R.string.notation_camelot,
                KeyNotation.OPEN_KEY to R.string.notation_open_key,
                KeyNotation.MUSICAL to R.string.notation_musical,
            )) {
                FilterChip(selected = ui.notation == n, onClick = { onNotation(n) }, label = { Text(stringResource(label)) })
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (ui.listening) {
                FilledTonalButton(onClick = onAgain) { Text(stringResource(R.string.listen_again)) }
                Button(onClick = onStop) { Text(stringResource(R.string.listen_stop)) }
            } else {
                Button(onClick = onStart) { Text(stringResource(R.string.listen_start)) }
            }
            FilledTonalButton(onClick = onPickFile, enabled = !ui.analysing) { Text(stringResource(R.string.open_file)) }
        }
        if (ui.listening) {
            Spacer(Modifier.height(8.dp))
            androidx.compose.material3.TextButton(onClick = onStage) { Text(stringResource(R.string.stage_mode)) }
        }
        if (s?.key != null && s.tempo != null) {
            Spacer(Modifier.height(8.dp))
            androidx.compose.material3.OutlinedButton(onClick = onSave, enabled = !ui.saved) {
                Text(stringResource(if (ui.saved) R.string.saved else R.string.save))
            }
        }
        if (ui.fileName == null) {
            Spacer(Modifier.height(16.dp))
            SongIdCard(ui, onIdentify, onTracklist, onAddToQueue)
        }
    }
}

@Composable
private fun Readout(
    label: String,
    value: String,
    detail: String?,
    sub: String?,
    onClick: (() -> Unit)? = null,
    badge: String? = null,
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = Mixai.colors.muted)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(value, fontSize = 44.sp, fontWeight = FontWeight.Bold, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            if (onClick != null) AssistChip(onClick = onClick, label = { Text(badge ?: "½× / 2×") }, modifier = Modifier.padding(start = 6.dp))
        }
        detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted) }
        sub?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = Mixai.colors.muted, style = MaterialTheme.typography.bodyMedium)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun ChromaStrip(chroma: List<Float>) {
    val names = listOf("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        chroma.forEachIndexed { i, v ->
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier.fillMaxWidth().height(36.dp),
                    contentAlignment = Alignment.BottomCenter,
                ) {
                    LinearProgressIndicator(
                        progress = { v.coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth().height((4 + 32 * v.coerceIn(0f, 1f)).dp),
                    )
                }
                Text(names[i], fontSize = 10.sp, color = Mixai.colors.muted)
            }
        }
    }
}
