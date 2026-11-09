package ro.mixai.decks.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.PadButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.engine.TracklistFormatUi
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksType

/**
 * Set recording (WP19-22): REC / stop, live automatic tracklist with remove, exports. [onExport]
 * receives the file extension and content (the shell saves / shares it); [recordPath] makes a new WAV path.
 */
@Composable
fun SetPanel(
    ctl: DecksController,
    recordPath: () -> String,
    onExport: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val type = LocalDecksType.current
    Panel(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BasicText(str(Str.SetTitle), style = type.label, modifier = Modifier.semantics { heading() })
                if (ctl.recordingOn) {
                    PadButton(str(Str.SetStop), str(Str.SetStop), active = true, accent = DecksColors.danger) { ctl.stopRecording() }
                    BasicText(Format.time(ctl.recordElapsed), style = type.body.copy(color = DecksColors.danger))
                } else {
                    PadButton(str(Str.SetRecord), str(Str.SetRecord)) { ctl.startRecording(recordPath()) }
                }
                if (ctl.recordError) BasicText(str(Str.SetRecordFailed), style = type.small.copy(color = DecksColors.danger))
            }
            if (ctl.tracklist.isEmpty()) {
                BasicText(str(Str.SetEmpty), style = type.small.copy(color = DecksColors.muted))
            }
            ctl.tracklist.forEachIndexed { i, e ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    val name = listOf(e.artist, e.title).filter { it.isNotBlank() }.joinToString(" – ").ifEmpty { "ID" }
                    BasicText(
                        "%02d. [%s] %s".format(i + 1, Format.time(e.startSec).substringBefore('.'), name),
                        style = type.body, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    PadButton("×", "${str(Str.SetRemove)}: $name") { ctl.removeTracklistEntry(i) }
                }
            }
            if (ctl.tracklist.isNotEmpty()) {
                val setName = str(Str.SetDefaultName)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (f in TracklistFormatUi.entries) {
                        val label = when (f) {
                            TracklistFormatUi.TEXT -> str(Str.SetExportText)
                            TracklistFormatUi.CUE -> "CUE"
                            TracklistFormatUi.ORDA_UCMR_CSV -> "ORDA / UCMR-ADA"
                            TracklistFormatUi.MIXCLOUD_SECTIONS -> "Mixcloud"
                            TracklistFormatUi.M3U8 -> "M3U8"
                        }
                        PadButton(label, "${str(Str.SetExport)}: $label") {
                            onExport(f.extension, ctl.exportTracklist(f, setName, ""))
                        }
                    }
                }
            }
        }
    }
}
