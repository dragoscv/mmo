package ro.mixai.decks.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.PadButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksType

/**
 * Library: scan a folder (platform picker via [onScanFolder]), search, crates, load to A/B.
 */
@Composable
fun LibraryPanel(ctl: DecksController, onScanFolder: (() -> Unit)?, modifier: Modifier = Modifier) {
    val type = LocalDecksType.current
    Panel(modifier) {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            // Crates column
            Column(Modifier.width(150.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                BasicText(str(Str.Crates), style = type.label, modifier = Modifier.semantics { heading() })
                CrateRow(str(Str.AllTracks), ctl.selectedCrate == null) { ctl.selectCrate(null) }
                ctl.crates.filter { !it.isFolder }.forEach { cr ->
                    CrateRow(cr.name, ctl.selectedCrate == cr.id) { ctl.selectCrate(cr.id) }
                }
                if (onScanFolder != null) {
                    PadButton(str(Str.ScanFolder), str(Str.ScanFolder), Modifier.fillMaxWidth()) { onScanFolder() }
                }
                ctl.scan?.let { s ->
                    val text = when {
                        s.failed -> s.error ?: "error"
                        s.finished -> str(Str.ScanDone, s.added)
                        else -> str(Str.Scanning, s.done, s.total)
                    }
                    BasicText(text, style = type.small.copy(color = DecksColors.muted))
                }
            }
            // Search + tracks
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val hint = str(Str.Search)
                Box(
                    Modifier.fillMaxWidth()
                        .background(DecksColors.surfaceRaised, RoundedCornerShape(8.dp))
                        .border(1.dp, DecksColors.border, RoundedCornerShape(8.dp))
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                ) {
                    if (ctl.query.isEmpty()) BasicText(hint, style = type.body.copy(color = DecksColors.muted))
                    BasicTextField(
                        ctl.query, { ctl.search(it) },
                        Modifier.fillMaxWidth().semantics { contentDescription = hint },
                        textStyle = type.body, singleLine = true, cursorBrush = SolidColor(DecksColors.primary),
                    )
                }
                if (ctl.results.isEmpty()) {
                    BasicText(str(Str.NoTracks), style = type.body.copy(color = DecksColors.muted), modifier = Modifier.padding(8.dp))
                } else {
                    val list = rememberLazyListState()
                    LaunchedEffect(ctl.selectedRow) {
                        if (ctl.selectedRow !in list.firstVisibleItemIndex until list.firstVisibleItemIndex + list.layoutInfo.visibleItemsInfo.size) {
                            list.animateScrollToItem(ctl.selectedRow)
                        }
                    }
                    LazyColumn(state = list, modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        itemsIndexed(ctl.results, key = { i, r -> r.id + "#" + i }) { i, r ->
                            val sel = i == ctl.selectedRow
                            Row(
                                Modifier.fillMaxWidth()
                                    .background(if (sel) DecksColors.accent else DecksColors.surface, RoundedCornerShape(6.dp))
                                    .clickable { ctl.selectedRow = i }
                                    .semantics(mergeDescendants = true) { selected = sel }
                                    .padding(horizontal = 8.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Column(Modifier.weight(1f)) {
                                    BasicText(r.title, style = type.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    BasicText(r.artist ?: "", style = type.small.copy(color = DecksColors.muted), maxLines = 1)
                                }
                                BasicText(Format.bpm(r.bpm), style = type.small)
                                BasicText(r.key ?: "—", style = type.small.copy(color = DecksColors.key(r.key)))
                                BasicText(r.durationSec?.let { Format.time(it).substringBefore('.') } ?: "", style = type.small)
                                PadButton("A", "${str(Str.LoadToA)}: ${r.title}", accent = DecksColors.deck(0)) { ctl.loadToDeck(0, r) }
                                PadButton("B", "${str(Str.LoadToB)}: ${r.title}", accent = DecksColors.deck(1)) { ctl.loadToDeck(1, r) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CrateRow(name: String, selected: Boolean, onClick: () -> Unit) {
    val type = LocalDecksType.current
    BasicText(
        name,
        style = type.body.copy(color = if (selected) DecksColors.foreground else DecksColors.muted),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth()
            .background(if (selected) DecksColors.accent else DecksColors.surface, RoundedCornerShape(6.dp))
            .clickable(onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 8.dp, vertical = 6.dp),
    )
}
