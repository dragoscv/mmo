package ro.mixai.keybpm.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ro.mixai.keybpm.ListenUi
import ro.mixai.keybpm.R
import ro.mixai.keybpm.data.LogEntry
import ro.mixai.listen.Harmony
import ro.mixai.mobile.theme.Mixai
import ro.mixai.mobile.theme.Tokens
import uniffi.mixai_listen_ffi.parseKey

/**
 * Practice (WP18 round 2): scale + chords in the current key, singer transpose from a short hum test, guitar capo,
 * key-change announcements (accessibility), and the set timeline (key colour + BPM line over the saved readings).
 */
@Composable
fun PracticeScreen(
    ui: ListenUi,
    entries: List<LogEntry>,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onAnnounce: (Boolean) -> Unit,
    onShareTimeline: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val songKey = ui.snapshot?.key?.key?.index?.toInt()
        ?: entries.firstOrNull()?.camelot?.let { parseKey(it) }?.index?.toInt()
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.tab_practice), style = MaterialTheme.typography.titleLarge)
        if (songKey != null) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text("${Harmony.camelot(songKey)} · ${Harmony.keyName(songKey)}", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text(stringResource(R.string.key_notes, Harmony.scale(songKey).joinToString(" ")))
                    Text(stringResource(R.string.key_chords, Harmony.chords(songKey).joinToString(" ")))
                    Spacer(Modifier.height(8.dp))
                    Text(stringResource(R.string.capo_title), style = MaterialTheme.typography.titleSmall)
                    val c = Harmony.capo(songKey)
                    Text(
                        if (c.fret == 0) stringResource(R.string.capo_open, Harmony.keyName(c.shapeKey))
                        else stringResource(R.string.capo_result, c.fret, Harmony.keyName(c.shapeKey)),
                    )
                }
            }
        }
        SingerCard(ui, songKey, onStart, onStop)
        Card(Modifier.fillMaxWidth()) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.a11y_announce), style = MaterialTheme.typography.titleSmall)
                    Text(stringResource(R.string.a11y_announce_hint), style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted)
                }
                Switch(checked = ui.announceKey, onCheckedChange = onAnnounce)
            }
        }
        TimelineCard(entries, onShareTimeline)
    }
}

@Composable
private fun SingerCard(ui: ListenUi, songKey: Int?, onStart: () -> Unit, onStop: () -> Unit) {
    var testing by remember { mutableStateOf(false) }
    val notes = remember { mutableStateListOf<Int>() }
    var centre by remember { mutableStateOf<Int?>(null) }
    // Collect clear pitch readings while the hum test runs (mic must be on; the tuner engine reports MIDI notes).
    LaunchedEffect(testing, ui.snapshot) {
        if (!testing) return@LaunchedEffect
        val p = ui.snapshot?.pitch ?: return@LaunchedEffect
        if (p.clarity > 0.85 && p.midi in 36..84) notes.add(p.midi)
    }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.sing_title), style = MaterialTheme.typography.titleSmall)
            Text(stringResource(R.string.sing_hint), style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted)
            if (testing) {
                Button(onClick = {
                    testing = false
                    centre = Harmony.voiceCentre(notes)
                    onStop()
                }) { Text(stringResource(R.string.sing_stop) + " (${notes.size})") }
            } else {
                FilledTonalButton(onClick = {
                    notes.clear()
                    testing = true
                    if (!ui.listening) onStart()
                }) { Text(stringResource(R.string.sing_start)) }
            }
            centre?.let { c ->
                Text(stringResource(R.string.sing_centre, Harmony.noteName(c) + (c / 12 - 1)))
                if (songKey == null) {
                    Text(stringResource(R.string.sing_need_key), color = Mixai.colors.muted)
                } else {
                    val t = Harmony.singerTranspose(songKey, c)
                    Text(
                        stringResource(R.string.sing_result, "%+d".format(t), Harmony.keyName(Harmony.transpose(songKey, t))),
                        style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
    }
}

@Composable
private fun TimelineCard(entries: List<LogEntry>, onShare: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.timeline_title), style = MaterialTheme.typography.titleSmall)
            val points = remember(entries) { entries.sortedBy { it.atMillis }.takeLast(60) }
            if (points.size < 2) {
                Text(stringResource(R.string.timeline_empty), color = Mixai.colors.muted)
                return@Column
            }
            val line = MaterialTheme.colorScheme.onSurface
            val desc = points.joinToString(", ") { "${it.camelot} ${"%.0f".format(it.bpm)}" }
            Canvas(Modifier.fillMaxWidth().height(140.dp).semantics { contentDescription = desc }) {
                drawTimeline(points, line, size)
            }
            OutlinedButton(onClick = onShare) { Text(stringResource(R.string.timeline_share)) }
        }
    }
}

/** Key colour band (Camelot token colours) + BPM polyline. Shared with the share-image renderer. */
fun androidx.compose.ui.graphics.drawscope.DrawScope.drawTimeline(points: List<LogEntry>, line: Color, area: androidx.compose.ui.geometry.Size) {
    val size = area
    val t0 = points.first().atMillis.toFloat()
    val span = (points.last().atMillis - points.first().atMillis).coerceAtLeast(1).toFloat()
    val lo = points.minOf { it.bpm }.toFloat() - 2f
    val hi = points.maxOf { it.bpm }.toFloat() + 2f
    val band = size.height * 0.18f
    for (i in points.indices) {
        val e = points[i]
        val k = parseKey(e.camelot) ?: continue
        val n = k.camelotNumber.toInt().coerceIn(1, 12) - 1
        val color = if (k.minor) Tokens.keyMinor[n] else Tokens.keyMajor[n]
        val x0 = (e.atMillis - t0) / span * size.width
        val x1 = if (i + 1 < points.size) (points[i + 1].atMillis - t0) / span * size.width else size.width
        drawRect(color, Offset(x0, size.height - band), androidx.compose.ui.geometry.Size((x1 - x0).coerceAtLeast(2f), band))
    }
    val path = Path()
    points.forEachIndexed { i, e ->
        val x = (e.atMillis - t0) / span * size.width
        val y = (1f - (e.bpm.toFloat() - lo) / (hi - lo)) * (size.height - band - 8f)
        if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
    }
    drawPath(path, line, style = Stroke(width = 3f))
}
