package ro.mixai.tv.ui.livetv

import android.view.TextureView
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.tv.R
import ro.mixai.tv.data.LiveTvGroup
import ro.mixai.tv.data.LiveTvNowNext
import ro.mixai.tv.data.generated.LiveTvChannel
import ro.mixai.tv.ui.components.Choice
import ro.mixai.tv.ui.components.ChoiceDialog
import ro.mixai.tv.ui.components.EmptyState
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.nav.rememberRestorableFocus
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

private const val PREVIEW_DELAY_MS = 600L
private const val GROUP_ALL = "\u0000all"
private const val GROUP_FAV = "\u0000fav"

private sealed interface ListState {
    data object Loading : ListState
    data class Error(val message: String) : ListState
    data object NoSources : ListState
    data class Ready(val channels: List<LiveTvChannel>) : ListState
}

private enum class ChannelAction { Watch, Favourite, Hide, Guide }

/**
 * Live TV home: group chips, virtualised channel list with now/next + progress, a muted live preview
 * of the focused channel (after 600 ms) and entry points to Guide, Recordings and Sources.
 */
@OptIn(UnstableApi::class)
@Composable
fun LiveTvScreen(deps: ScreenDeps, nav: Navigator) {
    val repo = deps.liveTv
    val scope = rememberCoroutineScope()
    var group by rememberSaveable { mutableStateOf(GROUP_ALL) }
    var showSources by rememberSaveable { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var state by remember { mutableStateOf<ListState>(ListState.Loading) }
    var groups by remember { mutableStateOf<List<LiveTvGroup>>(emptyList()) }
    var allCount by remember { mutableIntStateOf(0) }
    var favCount by remember { mutableIntStateOf(0) }
    var nowNext by remember { mutableStateOf<Map<String, LiveTvNowNext>>(emptyMap()) }
    var focused by remember { mutableStateOf<LiveTvChannel?>(null) }
    var actionFor by remember { mutableStateOf<LiveTvChannel?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    val now by rememberNow(30_000L)
    val errGeneric = stringResource(R.string.livetv_error_load)

    LaunchedEffect(group, reload) {
        if (state !is ListState.Ready) state = ListState.Loading
        state = try {
            val sources = repo.sources()
            if (sources.isEmpty()) ListState.NoSources
            else {
                val all = repo.channels()
                allCount = all.size
                favCount = all.count { it.favourite }
                groups = runCatching { repo.groups() }.getOrDefault(emptyList())
                val list = when (group) {
                    GROUP_ALL -> all
                    GROUP_FAV -> all.filter { it.favourite }
                    else -> all.filter { it.group == group }
                }
                ListState.Ready(list)
            }
        } catch (e: Exception) {
            ListState.Error(e.message ?: errGeneric)
        }
    }
    // now/next for every channel; refreshed every minute.
    LaunchedEffect(reload) {
        while (true) {
            runCatching { repo.nowNext() }.onSuccess { list -> nowNext = list.associateBy { it.channelId } }
            delay(60_000L)
        }
    }
    LaunchedEffect(notice) { if (notice != null) { delay(3_000); notice = null } }

    if (showSources) {
        LiveTvSourcesScreen(deps, onClose = { showSources = false; reload++ })
        return
    }

    val channels = (state as? ListState.Ready)?.channels.orEmpty()
    LaunchedEffect(channels) { if (channels.isNotEmpty()) LiveTvSession.channels = channels }

    Column(Modifier.fillMaxSize().padding(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = MixaiFocus.overscanTop)) {
        Header(
            onGuide = { nav.push(Route.Guide) },
            onRecordings = { nav.push(Route.Recordings) },
            onSources = { showSources = true },
        )
        Spacer(Modifier.height(12.dp))
        when (val s = state) {
            ListState.Loading -> LoadingState(rows = 3, hero = false)
            is ListState.Error -> ErrorState(s.message, onRetry = { reload++ })
            ListState.NoSources -> EmptyState(
                icon = MixaiIcons.LiveTv,
                title = stringResource(R.string.livetv_empty_title),
                message = stringResource(R.string.livetv_empty_message),
            ) { m -> PrimaryButton(stringResource(R.string.livetv_add_source), { showSources = true }, m, icon = MixaiIcons.LiveTv) }
            is ListState.Ready -> {
                GroupChips(groups, allCount, favCount, group) { group = it }
                Spacer(Modifier.height(12.dp))
                if (s.channels.isEmpty()) {
                    EmptyState(
                        icon = if (group == GROUP_FAV) Icons.Filled.Favorite else MixaiIcons.LiveTv,
                        title = stringResource(if (group == GROUP_FAV) R.string.livetv_no_favourites else R.string.livetv_no_channels),
                        message = stringResource(if (group == GROUP_FAV) R.string.livetv_no_favourites_hint else R.string.livetv_no_channels_hint),
                        focusAction = false,
                    )
                } else {
                    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                        ChannelList(
                            channels = s.channels, nowNext = nowNext, now = now, modifier = Modifier.weight(0.56f),
                            onFocus = { focused = it },
                            onPlay = { ch -> nav.push(Route.LivePlay(ch.id)) },
                            onMenu = { actionFor = it },
                        )
                        PreviewPane(deps, focused, focused?.let { nowNext[it.id] }, now, Modifier.weight(0.44f))
                    }
                }
            }
        }
    }

    notice?.let { msg -> Toast(msg) }

    val target = actionFor
    val favOn = stringResource(R.string.livetv_fav_added)
    val favOff = stringResource(R.string.livetv_fav_removed)
    val hidden = stringResource(R.string.livetv_hidden_done)
    ChoiceDialog(
        title = target?.name.orEmpty(),
        visible = target != null,
        options = listOf(
            Choice(ChannelAction.Watch, stringResource(R.string.livetv_action_watch)),
            Choice(ChannelAction.Favourite, stringResource(if (target?.favourite == true) R.string.livetv_action_unfavourite else R.string.livetv_action_favourite)),
            Choice(ChannelAction.Hide, stringResource(R.string.livetv_action_hide), stringResource(R.string.livetv_action_hide_hint)),
            Choice(ChannelAction.Guide, stringResource(R.string.livetv_guide)),
        ),
        selected = null,
        onDismiss = { actionFor = null },
        onPick = { a ->
            val ch = target ?: return@ChoiceDialog
            actionFor = null
            when (a) {
                ChannelAction.Watch -> nav.push(Route.LivePlay(ch.id))
                ChannelAction.Guide -> nav.push(Route.Guide)
                ChannelAction.Favourite -> scope.launch {
                    runCatching { repo.setFavourite(ch.id, !ch.favourite) }
                        .onSuccess { notice = if (ch.favourite) favOff else favOn; reload++ }
                        .onFailure { notice = it.message ?: errGeneric }
                }
                ChannelAction.Hide -> scope.launch {
                    runCatching { repo.updateChannel(ch.id, hidden = true) }
                        .onSuccess { notice = hidden; reload++ }
                        .onFailure { notice = it.message ?: errGeneric }
                }
            }
        },
    )
}

/** Transient message at the bottom of the screen. */
@Composable
internal fun Toast(message: String) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.BottomCenter) {
        Text(
            message, style = MaterialTheme.typography.titleSmall, color = Tokens.popoverForeground,
            modifier = Modifier.background(Tokens.popover, RoundedCornerShape(10.dp)).padding(horizontal = 20.dp, vertical = 12.dp),
        )
    }
}

@Composable
private fun Header(onGuide: () -> Unit, onRecordings: () -> Unit, onSources: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.wp16_nav_livetv), style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground, modifier = Modifier.weight(1f))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SecondaryButton(stringResource(R.string.livetv_guide), onGuide, icon = MixaiIcons.Guide)
            SecondaryButton(stringResource(R.string.livetv_recordings), onRecordings, icon = MixaiIcons.Record)
            SecondaryButton(stringResource(R.string.livetv_sources), onSources, icon = Icons.Filled.Settings)
        }
    }
}

@Composable
private fun GroupChips(groups: List<LiveTvGroup>, allCount: Int, favCount: Int, selected: String, onSelect: (String) -> Unit) {
    val items = buildList {
        add(GROUP_ALL to "${stringResource(R.string.livetv_group_all)} · $allCount")
        add(GROUP_FAV to "${stringResource(R.string.livetv_group_favourites)} · $favCount")
        groups.filter { it.name.isNotBlank() }.forEach { add(it.name to "${it.name} · ${it.count}") }
    }
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 4.dp)) {
        items(items, key = { it.first }) { (key, label) -> Pill(label, key == selected) { onSelect(key) } }
    }
}

/** Selectable pill (group chips, recording tabs). */
@Composable
internal fun Pill(label: String, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = modifier,
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(50)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (selected) Tokens.primary.copy(alpha = 0.30f) else Tokens.foreground.copy(alpha = 0.08f),
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
    ) {
        Text(label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
    }
}

@Composable
private fun ChannelList(
    channels: List<LiveTvChannel>,
    nowNext: Map<String, LiveTvNowNext>,
    now: Long,
    modifier: Modifier,
    onFocus: (LiveTvChannel) -> Unit,
    onPlay: (LiveTvChannel) -> Unit,
    onMenu: (LiveTvChannel) -> Unit,
) {
    val rf = rememberRestorableFocus("livetv-list")
    val listState = rememberLazyListState()
    LaunchedEffect(channels) { rf.restoreFocus() }
    LazyColumn(modifier.fillMaxSize(), state = listState, verticalArrangement = Arrangement.spacedBy(6.dp), contentPadding = PaddingValues(bottom = 48.dp)) {
        itemsIndexed(channels, key = { _, c -> c.id }) { i, ch ->
            val m = rf.item(ch.id).let { if (i == 0) it.focusRequester(rf.requester) else it }
            ChannelRow(ch, nowNext[ch.id], now, m, onFocus = { onFocus(ch) }, onClick = { onPlay(ch) }, onMenu = { onMenu(ch) })
        }
    }
}

@Composable
private fun ChannelRow(
    ch: LiveTvChannel,
    nn: LiveTvNowNext?,
    now: Long,
    modifier: Modifier,
    onFocus: () -> Unit,
    onClick: () -> Unit,
    onMenu: () -> Unit,
) {
    Surface(
        onClick = onClick,
        onLongClick = onMenu,
        modifier = modifier
            .fillMaxWidth()
            .onFocusChanged { if (it.isFocused) onFocus() }
            .onPreviewKeyEvent { e ->
                if (e.type == KeyEventType.KeyDown && e.key == Key.Menu) { onMenu(); true } else false
            },
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(12.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Tokens.card,
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.accent,
            focusedContentColor = Tokens.accentForeground,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.02f),
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(ch.number.orEmpty(), style = MaterialTheme.typography.titleSmall, color = Tokens.mutedForeground, modifier = Modifier.width(44.dp), maxLines = 1)
            ChannelLogo(ch, 52.dp)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(ch.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (ch.favourite) { Spacer(Modifier.width(6.dp)); Icon(Icons.Filled.Favorite, null, tint = Tokens.brandMagenta, modifier = Modifier.size(14.dp)) }
                    if (ch.catchup) { Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.livetv_badge_catchup), style = MaterialTheme.typography.labelSmall, color = Tokens.info) }
                }
                val cur = nn?.now
                if (cur != null) {
                    Text(cur.title, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.height(4.dp))
                    LiveProgress(cur.progressAt(now))
                } else {
                    Text(stringResource(R.string.livetv_no_guide), style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground, maxLines = 1)
                }
                nn?.next?.let { n ->
                    Spacer(Modifier.height(2.dp))
                    Text("${stringResource(R.string.livetv_next)} ${fmtTime(n.start)} · ${n.title}", style = MaterialTheme.typography.labelSmall, color = Tokens.mutedForeground, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/**
 * Muted mini preview of the focused channel: ONE player for the whole screen, released on leave.
 * TextureView (not SurfaceView) so it is clipped/rounded and follows the ultrawide UI squeeze.
 */
@OptIn(UnstableApi::class)
@Composable
private fun PreviewPane(deps: ScreenDeps, channel: LiveTvChannel?, nn: LiveTvNowNext?, now: Long, modifier: Modifier) {
    val context = LocalContext.current
    val resolver = remember(deps.api) { LiveTvSession.resolver(deps.api, deps.liveTv) }
    val player = remember {
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(liveMediaSourceFactory(context, deps.api, deps.liveTv.streamHeaders()))
            .setLoadControl(liveLoadControl())
            .build()
            .apply { volume = 0f }
    }
    var previewing by remember { mutableStateOf(false) }
    var previewFailed by remember { mutableStateOf(false) }
    DisposableEffect(player) {
        val l = object : Player.Listener {
            override fun onRenderedFirstFrame() { previewing = true }
            override fun onPlayerError(error: PlaybackException) { previewFailed = true; previewing = false }
        }
        player.addListener(l)
        onDispose { player.removeListener(l); player.release() }
    }
    // Stop the preview when the app goes to the background (Home button, screensaver).
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, ev -> if (ev == Lifecycle.Event.ON_STOP) player.stop() }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }
    LaunchedEffect(channel?.id) {
        previewing = false
        previewFailed = false
        player.stop()
        val ch = channel ?: return@LaunchedEffect
        delay(PREVIEW_DELAY_MS)
        val stream = runCatching { resolver.resolve(ch.id) }.getOrElse { previewFailed = true; return@LaunchedEffect }
        player.setMediaItem(liveMediaItem(ch.id, stream))
        player.prepare()
        player.playWhenReady = true
    }

    Column(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(14.dp)).background(Color.Black)) {
            AndroidView(
                factory = { ctx -> TextureView(ctx).also { player.setVideoTextureView(it) } },
                modifier = Modifier.fillMaxSize(),
            )
            if (!previewing && channel != null) {
                Box(Modifier.fillMaxSize().background(Tokens.card), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ChannelLogo(channel, 72.dp)
                        Text(
                            stringResource(if (previewFailed) R.string.livetv_preview_failed else R.string.livetv_preview_loading),
                            style = MaterialTheme.typography.labelMedium, color = Tokens.mutedForeground,
                        )
                    }
                }
            }
            if (previewing) LiveBadge(Modifier.align(Alignment.TopStart).padding(10.dp))
        }
        if (channel != null) {
            Text(listOfNotNull(channel.number, channel.name).joinToString("  "), style = MaterialTheme.typography.titleMedium, color = Tokens.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val cur = nn?.now
            if (cur != null) {
                Text(cur.title, style = MaterialTheme.typography.headlineSmall, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(listOfNotNull(fmtRange(cur), cur.category).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground)
                LiveProgress(cur.progressAt(now), height = 4.dp)
                cur.description?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground, maxLines = 4, overflow = TextOverflow.Ellipsis)
                }
            }
            nn?.next?.let { n ->
                Text("${stringResource(R.string.livetv_next)} ${fmtRange(n)} · ${n.title}", style = MaterialTheme.typography.bodySmall, color = Tokens.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(stringResource(R.string.livetv_hint_menu), style = MaterialTheme.typography.labelSmall, color = Tokens.mutedForeground)
        }
    }
}

@Composable
internal fun LiveBadge(modifier: Modifier = Modifier) {
    Text(
        stringResource(R.string.livetv_live), style = MaterialTheme.typography.labelSmall, color = Tokens.destructiveForeground,
        modifier = modifier.background(Tokens.destructive, RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 2.dp),
    )
}
