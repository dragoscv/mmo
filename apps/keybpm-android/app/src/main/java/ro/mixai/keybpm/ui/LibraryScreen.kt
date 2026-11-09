package ro.mixai.keybpm.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ro.mixai.keybpm.R
import ro.mixai.keybpm.library.CompatibleTrack
import ro.mixai.keybpm.library.Library
import ro.mixai.mobile.onboarding.DiscoverScreen
import ro.mixai.mobile.onboarding.ManualServerScreen
import ro.mixai.mobile.onboarding.PairScreen
import ro.mixai.mobile.theme.Mixai
import ro.mixai.tv.data.Connection
import ro.mixai.tv.data.DiscoveredServer
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.Settings
import uniffi.mixai_listen_ffi.KeyNotation
import uniffi.mixai_listen_ffi.keyLabel
import uniffi.mixai_listen_ffi.parseKey
import kotlin.math.roundToInt

private sealed interface Step {
    data object Idle : Step
    data object Discover : Step
    data object Manual : Step
    data class Pair(val server: DiscoveredServer) : Step
}

private sealed interface Load {
    data object Loading : Load
    data class Ok(val tracks: List<CompatibleTrack>) : Load
    data class Failed(val message: String) : Load
}

/**
 * "Mix next from my library" (D69): optional MMO Server connection with the shared connect screens, then the tracks
 * that mix from the detected key/BPM (server scorer, same as automix), tap = play in MixAI Music.
 */
@Composable
fun LibraryScreen(
    settings: Settings,
    camelot: String?,
    bpm: Double?,
    notation: KeyNotation,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val conn by settings.connection.collectAsState(initial = Connection("", ""))
    var step by remember { mutableStateOf<Step>(Step.Idle) }
    val saved: (String, String, String) -> Unit = { b, t, u -> scope.launch { settings.save(b, t, u); step = Step.Idle } }
    when (val s = step) {
        Step.Discover -> { DiscoverScreen(null, onSelect = { step = Step.Pair(it) }, onManual = { step = Step.Manual }, onBack = { step = Step.Idle }); return }
        Step.Manual -> { ManualServerScreen({ b, t -> saved(b, t, "") }, onQuickConnect = { step = Step.Pair(it) }, onBack = { step = Step.Discover }); return }
        is Step.Pair -> { PairScreen(s.server, onPaired = saved, onBack = { step = Step.Discover }); return }
        Step.Idle -> Unit
    }
    Column(modifier.fillMaxSize().padding(16.dp)) {
        Text(stringResource(R.string.tab_library), style = MaterialTheme.typography.titleLarge)
        if (!conn.isComplete) {
            Text(stringResource(R.string.library_intro), color = Mixai.colors.muted, modifier = Modifier.padding(vertical = 12.dp))
            Button(onClick = { step = Step.Discover }) { Text(stringResource(R.string.library_connect)) }
            return@Column
        }
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(conn.baseUrl, style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            OutlinedButton(onClick = { scope.launch { settings.clear() } }) { Text(stringResource(R.string.library_disconnect)) }
        }
        if (camelot == null && bpm == null) {
            Text(stringResource(R.string.library_need_reading), color = Mixai.colors.muted, modifier = Modifier.padding(top = 12.dp))
            return@Column
        }
        val keyText = camelot?.let { c -> parseKey(c)?.let { keyLabel(it.index, notation) } ?: c }
        Text(
            stringResource(R.string.library_for, listOfNotNull(keyText, bpm?.let { "%.1f BPM".format(it) }).joinToString(" · ")),
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        var load by remember { mutableStateOf<Load>(Load.Loading) }
        val api = remember(conn) { MmoApi(conn.baseUrl, conn.token) }
        LaunchedEffect(api, camelot, bpm?.roundToInt()) {
            load = Load.Loading
            load = runCatching { Library.compatible(api, camelot, bpm) }
                .fold({ Load.Ok(it.tracks) }, { Load.Failed(it.message ?: it.javaClass.simpleName) })
        }
        when (val l = load) {
            Load.Loading -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            is Load.Failed -> Text(stringResource(R.string.library_error, l.message), color = MaterialTheme.colorScheme.error)
            is Load.Ok -> if (l.tracks.isEmpty()) {
                Text(stringResource(R.string.library_empty), color = Mixai.colors.muted)
            } else {
                LazyColumn {
                    items(l.tracks, key = { it.id }) { t ->
                        Row(
                            Modifier.fillMaxWidth().clickable {
                                try {
                                    ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Library.playLink(t.id))))
                                } catch (_: ActivityNotFoundException) {
                                    android.widget.Toast.makeText(ctx, ctx.getString(R.string.library_need_music_app), android.widget.Toast.LENGTH_LONG).show()
                                }
                            }.padding(vertical = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(t.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(t.artist ?: "", style = MaterialTheme.typography.bodySmall, color = Mixai.colors.muted, maxLines = 1)
                                mixAdviceText(camelot, bpm, t.keyCamelot, t.bpm, notation)?.let {
                                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, maxLines = 1)
                                }
                            }
                            Text(
                                listOfNotNull(t.keyCamelot?.let { c -> parseKey(c)?.let { keyLabel(it.index, notation) } }, t.bpm?.let { "%.0f".format(it) }).joinToString(" · "),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text("${(t.score * 100).roundToInt()}%", color = Mixai.colors.success, style = MaterialTheme.typography.labelLarge)
                        }
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}

/**
 * One-line mix advice for a candidate track (WP18 round 2): beat-match rate, the key it lands on without key lock,
 * or the key-lock transpose that fixes a clash. Null when key or BPM is missing on either side.
 */
@Composable
fun mixAdviceText(liveCamelot: String?, liveBpm: Double?, trackCamelot: String?, trackBpm: Double?, notation: KeyNotation): String? {
    val live = liveCamelot?.let { parseKey(it) }?.index?.toInt() ?: return null
    val track = trackCamelot?.let { parseKey(it) }?.index?.toInt() ?: return null
    if (liveBpm == null || trackBpm == null) return null
    val a = ro.mixai.listen.Harmony.mixAdvice(live, liveBpm, track, trackBpm)
    val rate = "%+.1f %%".format(a.ratePercent)
    val label = { idx: Int -> keyLabel(idx.toUByte(), notation) }
    val atRate = a.keyAtRate
    return when {
        atRate != null -> stringResource(R.string.advice_lands, rate, label(atRate))
        a.transpose != 0 -> stringResource(R.string.advice_transpose, rate, "%+d".format(a.transpose), label(a.keyAfterTranspose))
        else -> stringResource(R.string.advice_rate, rate)
    }
}
