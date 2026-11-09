package ro.mixai.keybpm.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ro.mixai.keybpm.R
import ro.mixai.keybpm.midi.MidiClock
import ro.mixai.listen.TempoMath
import ro.mixai.mobile.theme.Mixai

/**
 * Tempo tools (WP18-08): MIDI clock out to a USB/BLE device, metronome click, tap tempo. "Follow" keeps the clock
 * on the detected BPM while listening; tapping or nudging switches to manual.
 */
data class DriftState(val enabled: Boolean, val reference: Double?, val drift: Double?)

@Composable
fun TempoScreen(
    clock: MidiClock,
    detectedBpm: Double?,
    modifier: Modifier = Modifier,
    drift: DriftState = DriftState(false, null, null),
    onDriftAlarm: (Boolean) -> Unit = {},
    onDriftReference: () -> Unit = {},
) {
    val st by clock.state.collectAsState()
    var follow by remember { mutableStateOf(true) }
    val taps = remember { mutableStateListOf<Long>() }
    DisposableEffect(clock) {
        clock.watch()
        onDispose { clock.unwatch() }
    }
    LaunchedEffect(follow, detectedBpm) {
        if (follow && detectedBpm != null) clock.setBpm(detectedBpm)
    }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(stringResource(R.string.tempo_title), style = MaterialTheme.typography.titleLarge, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = { follow = false; clock.setBpm(st.bpm - 0.1) }) { Text("−0.1") }
            Text("%.1f".format(st.bpm), fontSize = 56.sp, fontWeight = FontWeight.Bold)
            OutlinedButton(onClick = { follow = false; clock.setBpm(st.bpm + 0.1) }) { Text("+0.1") }
        }
        Text(stringResource(R.string.bpm_label), color = Mixai.colors.muted)
        Spacer(Modifier.height(12.dp))
        // Visual metronome: four dots, the current beat lit (works without sound).
        val cd = stringResource(R.string.cd_beat)
        Row(Modifier.semantics { contentDescription = cd }, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            repeat(4) { i ->
                val on = st.running && (st.beat % 4).toInt() == i
                Box(Modifier.size(18.dp).clip(CircleShape).background(if (on) MaterialTheme.colorScheme.primary else Mixai.colors.muted.copy(alpha = 0.3f)))
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = follow,
                enabled = detectedBpm != null,
                onClick = { follow = !follow },
                label = { Text(stringResource(R.string.tempo_follow)) },
            )
            FilledTonalButton(onClick = {
                follow = false
                val now = System.currentTimeMillis()
                taps.add(now)
                while (taps.size > 16) taps.removeAt(0)
                TempoMath.tapBpm(taps)?.let(clock::setBpm)
            }) { Text(stringResource(R.string.tempo_tap)) }
        }
        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.tempo_click), modifier = Modifier.weight(1f))
            Switch(checked = st.click, onCheckedChange = clock::setClick)
        }
        Spacer(Modifier.height(16.dp))
        Text(stringResource(R.string.tempo_midi_out), style = MaterialTheme.typography.titleMedium, modifier = Modifier.fillMaxWidth())
        when {
            !st.midiAvailable -> Text(stringResource(R.string.tempo_no_midi), color = Mixai.colors.muted, modifier = Modifier.fillMaxWidth())
            st.outputs.isEmpty() -> Text(stringResource(R.string.tempo_no_devices), color = Mixai.colors.muted, modifier = Modifier.fillMaxWidth())
            else -> st.outputs.forEach { out ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(out.name, modifier = Modifier.weight(1f))
                    if (st.connected?.id == out.id) OutlinedButton(onClick = clock::disconnect) { Text(stringResource(R.string.library_disconnect)) }
                    else OutlinedButton(onClick = { clock.connect(out) }) { Text(stringResource(R.string.tempo_connect)) }
                }
            }
        }
        Spacer(Modifier.height(20.dp))
        if (st.running) Button(onClick = clock::stop) { Text(stringResource(R.string.tempo_stop)) }
        else Button(onClick = clock::start) { Text(stringResource(R.string.tempo_start)) }
        Text(stringResource(R.string.tempo_hint), style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted, modifier = Modifier.padding(top = 8.dp))
        Spacer(Modifier.height(24.dp))
        // Drift alarm (bands, drummers): reference = first locked tempo, warns on a sustained > 0.5 % drift.
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.drift_title), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.drift_hint), style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted)
            }
            Switch(checked = drift.enabled, onCheckedChange = onDriftAlarm)
        }
        if (drift.enabled) {
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    drift.reference?.let { stringResource(R.string.drift_reference, it) } ?: "—",
                    modifier = Modifier.weight(1f),
                )
                OutlinedButton(onClick = onDriftReference, enabled = detectedBpm != null) { Text(stringResource(R.string.drift_set_ref)) }
            }
            drift.drift?.let {
                Text(
                    stringResource(R.string.drift_alert, it),
                    color = Mixai.colors.warning, style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                        .semantics { liveRegion = androidx.compose.ui.semantics.LiveRegionMode.Assertive },
                )
            }
        }
    }
}
