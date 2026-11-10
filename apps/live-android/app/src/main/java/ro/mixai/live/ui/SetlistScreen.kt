package ro.mixai.live.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ro.mixai.live.R
import ro.mixai.live.core.ClientMsg
import ro.mixai.live.core.ClientState
import ro.mixai.live.core.LiveClient
import ro.mixai.live.core.Role
import ro.mixai.mobile.theme.Mixai

/** Setlist with the current song/part highlighted and a lyrics teleprompter for the current song. */
@Composable
fun SetlistScreen(client: LiveClient, state: ClientState) {
    val s = state.session
    val setlist = s?.setlist
    if (setlist == null || setlist.songs.isEmpty()) {
        Text(stringResource(R.string.no_setlist), Modifier.padding(24.dp), color = Mixai.colors.muted)
        return
    }
    val pos = s.position
    val canGo = state.can(Role.PERFORMER)
    val list = rememberLazyListState()
    LaunchedEffect(pos?.song) { pos?.song?.let { list.animateScrollToItem(it.coerceAtLeast(0)) } }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(state = list, modifier = Modifier.weight(1f), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Text(setlist.name, style = MaterialTheme.typography.titleLarge)
                pos?.let { Text(stringResource(R.string.song_of, it.song + 1, setlist.songs.size), color = Mixai.colors.muted) }
            }
            itemsIndexed(setlist.songs, key = { i, song -> "$i-${song.title}" }) { i, song ->
                val current = pos?.song == i
                val currentPart = if (current) pos.part else null
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = if (current) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
                    ),
                ) {
                    Column(Modifier.fillMaxWidth().padding(12.dp)) {
                        Text("${i + 1}. ${song.title}", style = MaterialTheme.typography.titleMedium, fontWeight = if (current) FontWeight.Bold else FontWeight.Normal)
                        val meta = listOfNotNull(song.artist.ifBlank { null }, song.key, song.bpm?.let { "${Math.round(it)} BPM" }).joinToString(" · ")
                        if (meta.isNotBlank()) Text(meta, style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted)
                        Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            song.parts.forEachIndexed { j, part ->
                                FilterChip(
                                    selected = currentPart == j,
                                    onClick = { if (canGo) client.send(ClientMsg.Goto(i, j)) },
                                    enabled = canGo || currentPart == j,
                                    label = { Text(part.name) },
                                )
                            }
                        }
                    }
                }
            }
        }
        val song = s.currentSong
        HorizontalDivider()
        Column(Modifier.fillMaxWidth().weight(1f).padding(horizontal = 16.dp, vertical = 8.dp)) {
            Text(stringResource(R.string.lyrics), style = MaterialTheme.typography.labelLarge, color = Mixai.colors.muted)
            val lyrics = song?.lyrics?.takeIf { it.isNotBlank() }
            if (lyrics == null) {
                Text(stringResource(R.string.no_lyrics), color = Mixai.colors.muted)
            } else {
                // Big teleprompter text; resets to the top on song change.
                val scroll = rememberScrollState()
                LaunchedEffect(pos?.song) { scroll.scrollTo(0) }
                Text(
                    lyrics,
                    fontSize = 26.sp,
                    lineHeight = 36.sp,
                    modifier = Modifier.verticalScroll(scroll).clickable(enabled = false) {},
                )
            }
        }
    }
}
