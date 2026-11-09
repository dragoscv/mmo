package ro.mixai.keybpm.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ro.mixai.keybpm.R
import ro.mixai.keybpm.data.LogEntry
import ro.mixai.mobile.theme.Mixai
import ro.mixai.mobile.theme.Tokens
import uniffi.mixai_listen_ffi.KeyNotation
import uniffi.mixai_listen_ffi.keyLabel
import uniffi.mixai_listen_ffi.parseKey
import java.text.DateFormat
import java.util.Date

/** Set log: every saved reading, newest first; export as CSV through the share sheet. */
@Composable
fun HistoryScreen(
    entries: List<LogEntry>,
    notation: KeyNotation,
    onShareCsv: () -> Unit,
    onDelete: (Long) -> Unit,
    onClear: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var confirmClear by remember { mutableStateOf(false) }
    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            text = { Text(stringResource(R.string.history_clear_confirm)) },
            confirmButton = { TextButton(onClick = { confirmClear = false; onClear() }) { Text(stringResource(R.string.history_clear)) } },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text(stringResource(android.R.string.cancel)) } },
        )
    }
    Column(modifier.fillMaxSize().padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.tab_history), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            FilledTonalButton(onClick = onShareCsv, enabled = entries.isNotEmpty()) { Text(stringResource(R.string.history_export)) }
            OutlinedButton(onClick = { confirmClear = true }, enabled = entries.isNotEmpty()) { Text(stringResource(R.string.history_clear)) }
        }
        Spacer(Modifier.padding(4.dp))
        if (entries.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(stringResource(R.string.history_empty), color = Mixai.colors.muted)
            }
            return@Column
        }
        val time = remember { DateFormat.getTimeInstance(DateFormat.SHORT) }
        val day = remember { DateFormat.getDateInstance(DateFormat.MEDIUM) }
        LazyColumn {
            items(entries, key = { it.atMillis }) { e ->
                val k = remember(e.camelot) { parseKey(e.camelot) }
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    val idx = (k?.camelotNumber?.toInt() ?: 1) - 1
                    val dot: Color = if (k?.minor == true) Tokens.keyMinor[idx] else Tokens.keyMajor[idx]
                    Surface(shape = CircleShape, color = dot, modifier = Modifier.size(14.dp)) {}
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            (k?.let { keyLabel(it.index, notation) } ?: e.camelot) + "  ·  " + "%.1f BPM".format(e.bpm),
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            listOfNotNull(e.title, e.keyName, day.format(Date(e.atMillis)) + " " + time.format(Date(e.atMillis))).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = Mixai.colors.muted,
                        )
                    }
                    IconButton(onClick = { onDelete(e.atMillis) }) {
                        Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.history_delete))
                    }
                }
                HorizontalDivider()
            }
        }
    }
}
