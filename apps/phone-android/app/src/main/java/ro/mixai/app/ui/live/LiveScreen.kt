package ro.mixai.app.ui.live

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.LiveTv
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.Box
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.app.nav.Tab
import ro.mixai.app.ui.components.EmptyState
import ro.mixai.app.ui.components.ErrorState
import ro.mixai.app.ui.components.TabHeader
import ro.mixai.tv.data.LiveTvGroup
import ro.mixai.tv.data.LiveTvNowNext
import ro.mixai.tv.data.generated.LiveTvChannel
import ro.mixai.tv.data.generated.LiveTvProgramme

private const val PREFS = "phone_live"
private const val KEY_NOTICE = "notice_ok"
private const val FAV_FILTER = "\u0000fav"

@Composable
fun LiveScreen(deps: AppDeps, nav: Navigator) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    var noticeOk by remember { mutableStateOf(prefs.getBoolean(KEY_NOTICE, false)) }

    Column(Modifier.fillMaxSize()) {
        TabHeader(stringResource(R.string.tab_live), deps, nav)
        if (noticeOk) LiveContent(deps, nav)
    }

    if (!noticeOk) {
        AlertDialog(
            onDismissRequest = {},
            icon = { Icon(Icons.Outlined.LiveTv, contentDescription = null) },
            title = { Text(stringResource(R.string.live_notice_title)) },
            text = { Text(stringResource(R.string.live_notice_body)) },
            confirmButton = {
                TextButton(onClick = { prefs.edit().putBoolean(KEY_NOTICE, true).apply(); noticeOk = true }) {
                    Text(stringResource(R.string.live_notice_accept))
                }
            },
            dismissButton = { TextButton(onClick = { nav.selectTab(Tab.Home) }) { Text(stringResource(R.string.action_back)) } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LiveContent(deps: AppDeps, nav: Navigator) {
    var filter by rememberSaveable { mutableStateOf<String?>(null) } // null all, FAV_FILTER, or group name
    var mode by rememberSaveable { mutableIntStateOf(0) } // 0 channels, 1 guide
    var groups by remember { mutableStateOf<List<LiveTvGroup>>(emptyList()) }
    var channels by remember { mutableStateOf<List<LiveTvChannel>?>(null) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    val nowNext = remember { mutableStateMapOf<String, LiveTvNowNext>() }
    val favOverride = remember { mutableStateMapOf<String, Boolean>() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(attempt) { groups = runCatching { deps.liveTv.groups() }.getOrDefault(emptyList()) }
    LaunchedEffect(filter, attempt) {
        error = null
        channels = null
        try {
            channels = deps.liveTv.channels(
                group = filter?.takeIf { it != FAV_FILTER },
                favouritesOnly = filter == FAV_FILTER,
            )
            favOverride.clear()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e
        }
    }
    // Now/next refresh every 60 s while the list is shown.
    LaunchedEffect(channels) {
        val list = channels ?: return@LaunchedEffect
        if (list.isEmpty()) return@LaunchedEffect
        while (true) {
            runCatching { deps.liveTv.nowNext(list.map { it.id }) }.getOrNull()?.let { r ->
                nowNext.clear(); r.forEach { nowNext[it.channelId] = it }
            }
            delay(60_000)
        }
    }

    val list = channels
    if (list != null) LiveSession.channels = list

    Column(Modifier.fillMaxSize()) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
            val labels = listOf(R.string.live_mode_channels, R.string.live_mode_guide)
            labels.forEachIndexed { i, l ->
                SegmentedButton(selected = mode == i, onClick = { mode = i }, shape = SegmentedButtonDefaults.itemShape(i, labels.size)) {
                    Text(stringResource(l))
                }
            }
        }
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item { FilterChip(selected = filter == null, onClick = { filter = null }, label = { Text(stringResource(R.string.live_filter_all)) }) }
            item {
                FilterChip(
                    selected = filter == FAV_FILTER, onClick = { filter = FAV_FILTER },
                    label = { Text(stringResource(R.string.live_filter_favourites)) },
                    leadingIcon = { Icon(Icons.Filled.Star, contentDescription = null) },
                )
            }
            items(groups.distinctBy { it.name }, key = { it.name }) { g ->
                FilterChip(selected = filter == g.name, onClick = { filter = g.name }, label = { Text(g.name) })
            }
        }
        when {
            error != null -> ErrorState(error, onRetry = { attempt++ })
            list == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            list.isEmpty() && filter == FAV_FILTER -> EmptyState(Icons.Outlined.StarBorder, stringResource(R.string.live_no_favourites), stringResource(R.string.live_no_favourites_hint))
            list.isEmpty() && filter != null -> EmptyState(Icons.Outlined.LiveTv, stringResource(R.string.live_group_empty))
            list.isEmpty() -> EmptyState(Icons.Outlined.LiveTv, stringResource(R.string.live_empty_title), stringResource(R.string.live_empty_hint)) {
                Button(onClick = { attempt++ }) { Text(stringResource(R.string.action_retry)) }
            }
            mode == 0 -> ChannelList(
                deps, list, nowNext, favOverride,
                onOpen = { nav.push(Dest.LivePlayer(it.id)) },
                onFavourite = { ch, fav ->
                    favOverride[ch.id] = fav
                    scope.launch {
                        runCatching { deps.liveTv.setFavourite(ch.id, fav) }.onFailure { favOverride[ch.id] = !fav }
                    }
                },
            )
            else -> GuideList(deps, list, onOpen = { nav.push(Dest.LivePlayer(it.id)) })
        }
    }
}

@Composable
private fun ChannelList(
    deps: AppDeps,
    channels: List<LiveTvChannel>,
    nowNext: Map<String, LiveTvNowNext>,
    favOverride: Map<String, Boolean>,
    onOpen: (LiveTvChannel) -> Unit,
    onFavourite: (LiveTvChannel, Boolean) -> Unit,
) {
    val now by rememberNow(60_000L)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
        items(channels.distinctBy { it.id }, key = { it.id }) { ch ->
            val nn = nowNext[ch.id]
            val fav = favOverride[ch.id] ?: ch.favourite
            Row(
                Modifier.fillMaxWidth().clickable { onOpen(ch) }.padding(start = 16.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                ChannelLogo(deps.api, ch, 56.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        ch.number?.let {
                            Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.width(6.dp))
                        }
                        Text(ch.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    val cur = nn?.now
                    if (cur != null) {
                        Text(cur.title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        LinearProgressIndicator(
                            progress = { cur.progressAt(now) },
                            modifier = Modifier.fillMaxWidth().height(3.dp),
                            drawStopIndicator = {},
                        )
                    } else {
                        Text(stringResource(R.string.live_no_guide), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    nn?.next?.let { nx ->
                        Text(
                            stringResource(R.string.live_next_at, fmtTime(nx.start), nx.title),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                IconButton(onClick = { onFavourite(ch, !fav) }) {
                    Icon(
                        if (fav) Icons.Filled.Star else Icons.Outlined.StarBorder,
                        contentDescription = stringResource(if (fav) R.string.live_unfavourite else R.string.live_favourite),
                        tint = if (fav) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun GuideList(deps: AppDeps, channels: List<LiveTvChannel>, onOpen: (LiveTvChannel) -> Unit) {
    var programmes by remember(channels) { mutableStateOf<Map<String, List<LiveTvProgramme>>?>(null) }
    var error by remember(channels) { mutableStateOf<Throwable?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    val now by rememberNow(60_000L)
    LaunchedEffect(channels, attempt) {
        error = null
        try {
            val from = System.currentTimeMillis()
            val g = deps.liveTv.guide(from, from + 6 * 3_600_000L, channels.map { it.id })
            programmes = g.programmes.filter { it.stop > from }.distinctBy { it.channelId to it.start }.sortedBy { it.start }.groupBy { it.channelId }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e
        }
    }
    val p = programmes
    when {
        error != null -> ErrorState(error, onRetry = { attempt++ })
        p == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        p.isEmpty() -> EmptyState(Icons.Outlined.LiveTv, stringResource(R.string.live_guide_empty), stringResource(R.string.live_guide_empty_hint))
        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
            channels.forEach { ch ->
                val progs = p[ch.id].orEmpty()
                if (progs.isEmpty()) return@forEach
                item(key = "h_" + ch.id) {
                    Row(
                        Modifier.fillMaxWidth().clickable { onOpen(ch) }.padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        ChannelLogo(deps.api, ch, 36.dp)
                        Text(ch.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                items(progs.distinctBy { it.start }, key = { "p_${ch.id}_${it.start}" }) { prog ->
                    val onAir = now in prog.start until prog.stop
                    Row(
                        Modifier.fillMaxWidth().clickable(enabled = onAir) { onOpen(ch) }.padding(start = 64.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            fmtTime(prog.start), style = MaterialTheme.typography.labelLarge,
                            color = if (onAir) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.width(48.dp),
                        )
                        Column(Modifier.weight(1f)) {
                            Text(
                                prog.title, style = MaterialTheme.typography.bodyMedium,
                                fontWeight = if (onAir) FontWeight.SemiBold else FontWeight.Normal, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            )
                            if (onAir) {
                                Text(stringResource(R.string.live_on_now), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                }
                item(key = "d_" + ch.id) { HorizontalDivider(Modifier.padding(top = 4.dp)) }
            }
        }
    }
}
