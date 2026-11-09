package ro.mixai.decks.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.PadButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksType

/** AI Transition Designer (WP19-20): suggestions, auto mix with progress, set safety, typed command. */
@Composable
fun AiPanel(ctl: DecksController, modifier: Modifier = Modifier) {
    val type = LocalDecksType.current
    var text by remember { mutableStateOf("") }
    Panel(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BasicText(str(Str.AiTitle), style = type.label, modifier = Modifier.semantics { heading() })
                PadButton(str(Str.AiSuggest), str(Str.AiSuggest)) { ctl.suggestNext() }
                if (ctl.mixProgress == null) {
                    PadButton(str(Str.AiMix), str(Str.AiMix)) { ctl.planMix(); ctl.startMix() }
                } else {
                    BasicText(str(Str.AiMixing, ((ctl.mixProgress ?: 0.0) * 100).toInt()), style = type.small)
                    PadButton(str(Str.AiCancel), str(Str.AiCancel)) { ctl.cancelMix() }
                }
            }
            for (w in ctl.safety) {
                BasicText(
                    str(Str.AiWarning, w.code.replace('_', ' ')),
                    style = type.small.copy(color = if (w.severity >= 2) DecksColors.danger else DecksColors.warning),
                )
            }
            for (s in ctl.suggestions.take(5)) {
                val row = ctl.results.firstOrNull { it.id == s.id }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    BasicText("${row?.title ?: s.id} · ${(s.score * 100).toInt()}", style = type.body, modifier = Modifier.weight(1f))
                    PadButton(str(Str.AiLoad), "${str(Str.AiLoad)}: ${row?.title ?: s.id}") { ctl.loadSuggestion(s.id) }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                val hint = str(Str.AiCommandHint)
                BasicTextField(
                    text, { text = it }, singleLine = true,
                    textStyle = type.body.copy(color = DecksColors.foreground),
                    modifier = Modifier.weight(1f).semantics { contentDescription = hint },
                )
                PadButton(str(Str.AiRun), str(Str.AiRun)) { if (ctl.command(text)) text = "" }
            }
        }
    }
}
