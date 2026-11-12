package ro.mixai.live.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import ro.mixai.live.R
import ro.mixai.live.core.ClientMsg
import ro.mixai.live.core.ClientState
import ro.mixai.live.core.LiveClient
import ro.mixai.live.core.MidiAction
import ro.mixai.live.core.MidiBinding
import ro.mixai.live.core.MidiSource
import ro.mixai.live.core.MidiTarget
import ro.mixai.live.core.MixField
import ro.mixai.live.core.Role
import ro.mixai.mobile.theme.Mixai
import java.util.Locale

/**
 * MIDI mapping (controller role): the ports the engine has open, the last message seen, the learned bindings with
 * unbind, the channel filter and the program-change toggle. Learning itself starts from a long press on a control
 * (chain parameters, insert on/off, mix faders) and is shown by [MidiLearnBanner].
 */
@Composable
fun MidiScreen(client: LiveClient, state: ClientState) {
    if (!state.can(Role.CONTROLLER)) {
        Text(stringResource(R.string.midi_controller_only), Modifier.padding(24.dp), color = Mixai.colors.muted)
        return
    }
    val midi = state.midi
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        MidiLearnBanner(client, state)

        Section(stringResource(R.string.midi_ports)) {
            if (midi.ports.isEmpty()) {
                Text(stringResource(R.string.midi_no_ports), style = MaterialTheme.typography.bodyMedium, color = Mixai.colors.muted)
            } else {
                midi.ports.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
            }
            Text(
                midi.last ?: stringResource(R.string.midi_no_activity),
                style = MaterialTheme.typography.labelMedium,
                color = if (midi.last != null) Mixai.colors.success else Mixai.colors.muted,
            )
        }

        Section(stringResource(R.string.midi_bindings)) {
            if (midi.map.bindings.isEmpty()) {
                Text(stringResource(R.string.midi_no_bindings), style = MaterialTheme.typography.bodyMedium, color = Mixai.colors.muted)
            } else {
                midi.map.bindings.forEachIndexed { i, b ->
                    if (i > 0) HorizontalDivider(color = Mixai.colors.border)
                    BindingRow(b) { client.send(ClientMsg.MidiUnbind(i)) }
                }
            }
        }

        Section(stringResource(R.string.midi_settings)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.midi_program_change), style = MaterialTheme.typography.bodyLarge)
                    Text(stringResource(R.string.midi_program_change_hint), style = MaterialTheme.typography.labelSmall, color = Mixai.colors.muted)
                }
                Switch(
                    checked = midi.map.programChange,
                    onCheckedChange = { client.send(ClientMsg.MidiSettings(programChange = it)) },
                )
            }
            Text(stringResource(R.string.midi_channel), style = MaterialTheme.typography.bodyLarge)
            // Wire values are 1..16 with 0 = omni; the engine stores the channel 0-based.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val selected = midi.map.channel?.plus(1) ?: 0
                FilterChip(
                    selected = selected == 0,
                    onClick = { client.send(ClientMsg.MidiSettings(channel = 0)) },
                    label = { Text(stringResource(R.string.midi_channel_omni)) },
                )
                (1..16).forEach { ch ->
                    FilterChip(
                        selected = selected == ch,
                        onClick = { client.send(ClientMsg.MidiSettings(channel = ch)) },
                        label = { Text(ch.toString()) },
                    )
                }
            }
        }
    }
}

/** "Waiting for MIDI…" while the engine has a learn target armed, with a cancel button. */
@Composable
fun MidiLearnBanner(client: LiveClient, state: ClientState) {
    val target = state.midiLearning ?: return
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    stringResource(R.string.midi_learn_waiting, targetLabel(target)),
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
                Text(
                    stringResource(R.string.midi_learn_hint),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
            TextButton(onClick = { client.send(ClientMsg.MidiLearn(null)) }) { Text(stringResource(R.string.cancel)) }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun BindingRow(b: MidiBinding, onUnbind: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(targetLabel(b.target), style = MaterialTheme.typography.bodyLarge)
            Text(sourceLabel(b.source), style = MaterialTheme.typography.labelMedium, color = Mixai.colors.muted)
        }
        IconButton(onClick = onUnbind) {
            Icon(Icons.Filled.Close, stringResource(R.string.midi_unbind), Modifier.size(20.dp))
        }
    }
}

/** "CC 80 · ch 1" / "Note 36 · any channel" (channels are 0-based on the wire, 1-based for people). */
@Composable
fun sourceLabel(s: MidiSource): String {
    val what = stringResource(if (s.isNote) R.string.midi_source_note else R.string.midi_source_cc, s.number)
    val ch = s.channel?.let { stringResource(R.string.midi_source_channel, it + 1) } ?: stringResource(R.string.midi_source_channel_any)
    return "$what · $ch"
}

@Composable
fun targetLabel(t: MidiTarget): String = when (t) {
    is MidiTarget.Param -> stringResource(R.string.midi_target_param, fxLabel(t.fx), t.param.replace('_', ' '))
    is MidiTarget.Enable -> stringResource(R.string.midi_target_enable, fxLabel(t.fx))
    is MidiTarget.Mix -> stringResource(
        when (t.field) {
            MixField.INPUT_DB -> R.string.input_gain
            MixField.MAIN_DB -> R.string.main_level
            MixField.MONITOR_DB -> R.string.monitor_level
            MixField.MONITOR_DRY -> R.string.monitor_dry
        },
    )
    is MidiTarget.Action -> stringResource(
        when (t.action) {
            MidiAction.NEXT -> R.string.next_scene
            MidiAction.PREV -> R.string.prev_scene
            MidiAction.TAP_TEMPO -> R.string.tap
            MidiAction.PANIC -> R.string.panic
            MidiAction.TOGGLE_BYPASS -> R.string.midi_action_toggle_bypass
            MidiAction.TOGGLE_MUTE -> R.string.midi_action_toggle_mute
        },
    )
    is MidiTarget.Unknown -> stringResource(R.string.midi_target_unknown, t.kind)
}

/**
 * Display name of an engine effect id (`fx_<id>` string resource). Ids are wire names: `autotune` is shown as
 * "Pitch correction". Unknown ids (a newer engine) fall back to the title-cased id.
 */
@Composable
fun fxLabel(fx: String): String {
    val res = when (fx) {
        "gate" -> R.string.fx_gate
        "eq" -> R.string.fx_eq
        "deesser" -> R.string.fx_deesser
        "compressor" -> R.string.fx_compressor
        "autotune" -> R.string.fx_autotune
        "harmonizer" -> R.string.fx_harmonizer
        "saturator" -> R.string.fx_saturator
        "doubler" -> R.string.fx_doubler
        "chorus" -> R.string.fx_chorus
        "delay" -> R.string.fx_delay
        "reverb" -> R.string.fx_reverb
        "limiter" -> R.string.fx_limiter
        "tuner" -> R.string.fx_tuner
        else -> return fx.replace('_', ' ').replaceFirstChar { it.titlecase(Locale.ROOT) }
    }
    return stringResource(res)
}
