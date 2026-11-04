package ro.mixai.tv.ui.livetv

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.tv.R
import ro.mixai.tv.data.generated.LiveTvChannel
import ro.mixai.tv.data.generated.LiveTvProgramme
import ro.mixai.tv.ui.components.EmptyState
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens
import kotlin.math.max
import kotlin.math.roundToInt

private const val MIN = 60_000L
private const val SLOT = 30 * MIN
private const val HOUR = 60 * MIN
private const val DAY = 24 * HOUR
private const val CHUNK = 6 * HOUR
private const val DP_PER_MIN = 5f
private val ROW_H = 64.dp
private val CHANNEL_W = 230.dp

private fun floorSlot(ms: Long) = Math.floorDiv(ms, SLOT) * SLOT

/** One grid cell: a programme, or a 30-minute filler where the guide has no data. */
@Stable
private data class Cell(val start: Long, val stop: Long, val programme: LiveTvProgramme?)

/** Guide data cache: programmes per channel, merged from 6 h windows loaded on demand. */
private class GuideData {
    var byChannel: Map<String, List<LiveTvProgramme>> = emptyMap()
    val loaded = HashSet<Long>()

    fun merge(list: List<LiveTvProgramme>) {
        val m = byChannel.toMutableMap()
        list.groupBy { it.channelId }.forEach { (id, progs) ->
            val old = m[id].orEmpty()
            m[id] = (old + progs).distinctBy { it.start }.sortedBy { it.start }
        }
        byChannel = m
    }

    /** Cells of [channelId] covering [from, to), gaps filled with slot-aligned fillers. */
    fun cells(channelId: String, from: Long, to: Long): List<Cell> {
        val progs = byChannel[channelId].orEmpty()
        val out = ArrayList<Cell>()
        var t = from
        // first programme that ends after `from`
        var i = lowerBoundStop(progs, from)
        while (t < to) {
            val p = progs.getOrNull(i)
            if (p != null && p.start <= t && p.stop > t) {
                out += Cell(p.start, p.stop, p); t = p.stop; i++
            } else {
                val nextStart = p?.start?.takeIf { it > t } ?: Long.MAX_VALUE
                val fillerStop = minOf(floorSlot(t) + SLOT, nextStart)
                // Same start whether computed for a whole lane or a single time (focus identity).
                val prevStop = progs.getOrNull(i - 1)?.stop?.takeIf { it <= t } ?: Long.MIN_VALUE
                out += Cell(maxOf(floorSlot(t), prevStop), fillerStop, null)
                t = fillerStop
                if (p != null && p.stop <= t) i++
            }
        }
        return out
    }

    fun cellAt(channelId: String, time: Long): Cell = cells(channelId, time, time + 1).first()

    private fun lowerBoundStop(progs: List<LiveTvProgramme>, t: Long): Int {
        var lo = 0; var hi = progs.size
        while (lo < hi) { val mid = (lo + hi) ushr 1; if (progs[mid].stop <= t) lo = mid + 1 else hi = mid }
        return lo
    }
}

/**
 * EPG grid: sticky channel column + time ruler, "now" line, cells sized by duration, both axes
 * virtualised (LazyColumn rows; each lane renders only cells intersecting the view ±1 h and is
 * positioned by ONE shared horizontal offset read at layout time). D-pad moves a virtual cursor
 * cell-to-cell; the grid itself is a single focus node (cheap on Chromecast).
 */
@Composable
fun GuideScreen(deps: ScreenDeps, nav: Navigator) {
    val repo = deps.liveTv
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val data = remember { GuideData() }
    var version by remember { mutableIntStateOf(0) }
    var channels by remember { mutableStateOf<List<LiveTvChannel>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val startNow = remember { System.currentTimeMillis() }
    var viewStart by remember { mutableLongStateOf(floorSlot(startNow) - SLOT) }
    var focusTime by remember { mutableLongStateOf(startNow) }
    var row by remember { mutableIntStateOf(0) }
    var gridFocused by remember { mutableStateOf(false) }
    var details by remember { mutableStateOf<Pair<LiveTvChannel, Cell>?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var perfStarted by remember { mutableStateOf(false) }
    val gridFocus = remember { FocusRequester() }
    val listState = rememberLazyListState()
    val now by rememberNow(30_000L)
    val errGeneric = stringResource(R.string.livetv_error_load)

    LaunchedEffect(reload) {
        error = null
        try {
            val list = LiveTvSession.channels.ifEmpty { repo.channels() }
            channels = list
            row = list.indexOfFirst { it.id == LiveTvSession.lastChannelId }.coerceAtLeast(0)
        } catch (e: Exception) { error = e.message ?: errGeneric }
    }

    fun ensureLoaded(from: Long, to: Long) {
        var c = Math.floorDiv(from, CHUNK)
        val end = Math.floorDiv(to, CHUNK)
        while (c <= end) {
            val chunk = c
            if (data.loaded.add(chunk)) {
                scope.launch {
                    runCatching { repo.guide(chunk * CHUNK, chunk * CHUNK + CHUNK) }
                        .onSuccess { g -> data.merge(g.programmes); version++ }
                        .onFailure { data.loaded.remove(chunk) }
                }
            }
            c++
        }
    }

    BackHandler(enabled = details != null) { details = null; scope.launch { delay(50); runCatching { gridFocus.requestFocus() } } }
    LaunchedEffect(notice) { if (notice != null) { delay(3_000); notice = null } }

    Column(Modifier.fillMaxSize().padding(start = MixaiFocus.overscan, end = MixaiFocus.overscan / 2, top = MixaiFocus.overscanTop)) {
        // Toolbar: title, date, day jumps, Now.
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.livetv_guide), style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground)
                Text(fmtDay(focusTime) + " · " + fmtTime(focusTime), style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SecondaryButton(stringResource(R.string.livetv_day_prev), {
                    focusTime -= DAY; viewStart -= DAY
                })
                PrimaryButton(stringResource(R.string.livetv_now), {
                    val t = System.currentTimeMillis(); focusTime = t; viewStart = floorSlot(t) - SLOT
                    scope.launch { delay(50); runCatching { gridFocus.requestFocus() } }
                })
                SecondaryButton(stringResource(R.string.livetv_day_next), {
                    focusTime += DAY; viewStart += DAY
                })
            }
        }
        Spacer(Modifier.height(12.dp))

        val list = channels
        when {
            error != null -> ErrorState(error!!, onRetry = { reload++ })
            list == null -> LoadingState(rows = 4, hero = false)
            list.isEmpty() -> EmptyState(MixaiIcons.Guide, stringResource(R.string.livetv_no_channels), stringResource(R.string.livetv_empty_message), focusAction = false)
            else -> BoxWithConstraints(Modifier.fillMaxSize()) {
                val laneWidthDp = maxWidth - CHANNEL_W
                val spanMs = (laneWidthDp.value / DP_PER_MIN * MIN).toLong()
                LaunchedEffect(viewStart, spanMs) { ensureLoaded(viewStart - HOUR, viewStart + spanMs + HOUR) }
                LaunchedEffect(Unit) { delay(80); runCatching { gridFocus.requestFocus() } }
                val density = LocalDensity.current
                val pxPerMin = with(density) { DP_PER_MIN.dp.toPx() }
                val animView by animateFloatAsState(((viewStart - startNow) / MIN).toFloat(), tween(160), label = "guide-x")
                fun xPx(ms: Long): Int = (((ms - startNow) / MIN.toFloat() - animView) * pxPerMin).roundToInt()

                fun keepVisible() {
                    if (focusTime < viewStart || focusTime >= viewStart + spanMs - SLOT) viewStart = floorSlot(focusTime - spanMs / 3)
                }
                fun scrollRowIntoView() {
                    val info = listState.layoutInfo
                    val first = info.visibleItemsInfo.firstOrNull()?.index ?: 0
                    val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
                    scope.launch {
                        if (row <= first) listState.animateScrollToItem((row - 1).coerceAtLeast(0))
                        else if (row >= last) listState.animateScrollToItem((row - (last - first) + 1).coerceAtLeast(0))
                    }
                }

                Column(Modifier.fillMaxSize()) {
                    // Sticky time ruler.
                    Row(Modifier.fillMaxWidth().height(32.dp)) {
                        Spacer(Modifier.width(CHANNEL_W))
                        Box(Modifier.weight(1f).fillMaxHeight().clipToBounds()) {
                            var t = floorSlot(viewStart - HOUR)
                            while (t < viewStart + spanMs + HOUR) {
                                val slot = t
                                Text(
                                    fmtTime(slot), style = MaterialTheme.typography.labelMedium, color = Tokens.mutedForeground,
                                    modifier = Modifier.offset { IntOffset(xPx(slot) + 6, 0) }.align(Alignment.CenterStart),
                                )
                                t += SLOT
                            }
                        }
                    }
                    Box(
                        Modifier
                            .fillMaxSize()
                            .focusRequester(gridFocus)
                            .onFocusChanged { gridFocused = it.isFocused }
                            .focusable()
                            .onKeyEvent { ev ->
                                if (ev.type != KeyEventType.KeyDown) return@onKeyEvent false
                                val isMove = ev.key == Key.DirectionRight || ev.key == Key.DirectionLeft || ev.key == Key.DirectionDown || ev.key == Key.DirectionUp
                                if (isMove && !perfStarted) { perfStarted = true; FramePerf.sample("guide-scroll") }
                                val ch = list.getOrNull(row) ?: return@onKeyEvent false
                                when (ev.key) {
                                    Key.DirectionRight -> {
                                        val cur = data.cellAt(ch.id, focusTime)
                                        focusTime = data.cells(ch.id, cur.stop, cur.stop + 1).first().start.coerceAtLeast(cur.stop)
                                        keepVisible(); true
                                    }
                                    Key.DirectionLeft -> {
                                        val cur = data.cellAt(ch.id, focusTime)
                                        val prev = data.cellAt(ch.id, cur.start - 1)
                                        // Stay near the boundary so a long previous programme does not jump hours back.
                                        focusTime = max(prev.start, cur.start - SLOT)
                                        keepVisible(); true
                                    }
                                    Key.DirectionDown -> {
                                        if (row < list.lastIndex) { row++; scrollRowIntoView() }; true
                                    }
                                    Key.DirectionUp -> {
                                        if (row > 0) { row--; scrollRowIntoView(); true } else false
                                    }
                                    Key.ChannelUp -> { row = (row - 8).coerceAtLeast(0); scope.launch { listState.scrollToItem(row) }; true }
                                    Key.ChannelDown -> { row = (row + 8).coerceAtMost(list.lastIndex); scope.launch { listState.scrollToItem(row) }; true }
                                    Key.DirectionCenter, Key.Enter -> { details = ch to data.cellAt(ch.id, focusTime); true }
                                    else -> false
                                }
                            },
                    ) {
                        LazyColumn(state = listState, userScrollEnabled = false, modifier = Modifier.fillMaxSize()) {
                            itemsIndexed(list, key = { _, c -> c.id }) { i, ch ->
                                val focusedCell = if (gridFocused && i == row) data.cellAt(ch.id, focusTime) else null
                                GuideRow(
                                    ch = ch,
                                    cells = remember(ch.id, viewStart, spanMs, version) { data.cells(ch.id, viewStart - HOUR, viewStart + spanMs + HOUR) },
                                    focusedStart = focusedCell?.start,
                                    selectedRow = i == row,
                                    now = now,
                                    pxPerMin = pxPerMin,
                                    xPx = ::xPx,
                                )
                            }
                        }
                        // "Now" line across the lanes.
                        if (now in viewStart - HOUR..viewStart + spanMs + HOUR) {
                            Box(
                                Modifier
                                    .padding(start = CHANNEL_W)
                                    .offset { IntOffset(xPx(now), 0) }
                                    .width(2.dp)
                                    .fillMaxHeight()
                                    .background(Tokens.destructive),
                            )
                        }
                    }
                }
            }
        }
    }

    // Details panel.
    val d = details
    AnimatedVisibility(
        visible = d != null,
        enter = fadeIn() + slideInHorizontally { it / 2 },
        exit = fadeOut() + slideOutHorizontally { it / 2 },
    ) {
        if (d != null) {
            DetailsPanel(
                ch = d.first, cell = d.second, now = System.currentTimeMillis(),
                onWatch = { p ->
                    val ch = d.first
                    LiveTvSession.channels = channels.orEmpty()
                    if (p != null && p.stop <= System.currentTimeMillis()) {
                        LiveTvSession.pendingCatchup = CatchupRequest(ch.id, p.start, ((p.stop - p.start) / MIN).toInt(), p.title)
                    }
                    details = null
                    nav.push(Route.LivePlay(ch.id))
                },
                onRecord = { p ->
                    scope.launch {
                        runCatching { repo.recordProgramme(d.first.id, p.start) }
                            .onSuccess { r -> notice = context.getString(if (r.conflict) R.string.livetv_record_conflict else R.string.livetv_record_scheduled) }
                            .onFailure { notice = it.message ?: errGeneric }
                    }
                },
                onSeries = { p ->
                    scope.launch {
                        runCatching { repo.createRule(p.title, channelId = d.first.id) }
                            .onSuccess { notice = context.getString(R.string.livetv_series_created) }
                            .onFailure { notice = it.message ?: errGeneric }
                    }
                },
                onClose = { details = null; scope.launch { delay(50); runCatching { gridFocus.requestFocus() } } },
            )
        }
    }
    notice?.let { Toast(it) }
}

@Composable
private fun GuideRow(
    ch: LiveTvChannel,
    cells: List<Cell>,
    focusedStart: Long?,
    selectedRow: Boolean,
    now: Long,
    pxPerMin: Float,
    xPx: (Long) -> Int,
) {
    Row(Modifier.fillMaxWidth().height(ROW_H).padding(vertical = 2.dp)) {
        // Sticky channel column.
        Row(
            Modifier.width(CHANNEL_W).fillMaxHeight().padding(end = 6.dp)
                .background(if (selectedRow) Tokens.accent else Tokens.card, RoundedCornerShape(8.dp))
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(ch.number.orEmpty(), style = MaterialTheme.typography.labelMedium, color = Tokens.mutedForeground, modifier = Modifier.width(36.dp), maxLines = 1)
            ChannelLogo(ch, 40.dp)
            Spacer(Modifier.width(8.dp))
            Text(ch.name, style = MaterialTheme.typography.labelMedium, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.weight(1f).fillMaxHeight().clipToBounds()) {
            val density = LocalDensity.current
            for (c in cells) {
                val focused = focusedStart == c.start
                val past = c.stop <= now
                val onAir = now in c.start until c.stop
                val widthDp = with(density) { ((c.stop - c.start) / MIN.toFloat() * pxPerMin).toDp() } - 3.dp
                Box(
                    Modifier
                        .offset { IntOffset(xPx(c.start), 0) }
                        .width(widthDp.coerceAtLeast(4.dp))
                        .fillMaxHeight()
                        .background(
                            when {
                                focused -> Tokens.foreground
                                onAir -> Tokens.secondary
                                past -> Tokens.card.copy(alpha = 0.6f)
                                else -> Tokens.card
                            },
                            RoundedCornerShape(6.dp),
                        )
                        .then(if (onAir && !focused) Modifier.border(1.dp, Tokens.primary.copy(alpha = 0.5f), RoundedCornerShape(6.dp)) else Modifier)
                        .padding(horizontal = 10.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    // Keep the title readable when the cell starts left of the viewport.
                    Column(Modifier.offset { IntOffset(max(0, -xPx(c.start)), 0) }) {
                        Text(
                            c.programme?.title ?: stringResource(R.string.livetv_no_info),
                            style = MaterialTheme.typography.labelMedium,
                            color = if (focused) Tokens.background else if (past) Tokens.mutedForeground else Tokens.foreground,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        if (c.programme != null) {
                            Text(
                                fmtTime(c.start), style = MaterialTheme.typography.labelSmall,
                                color = if (focused) Tokens.background.copy(alpha = 0.7f) else Tokens.mutedForeground, maxLines = 1,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DetailsPanel(
    ch: LiveTvChannel,
    cell: Cell,
    now: Long,
    onWatch: (LiveTvProgramme?) -> Unit,
    onRecord: (LiveTvProgramme) -> Unit,
    onSeries: (LiveTvProgramme) -> Unit,
    onClose: () -> Unit,
) {
    val p = cell.programme
    val first = remember { FocusRequester() }
    LaunchedEffect(cell) { delay(80); runCatching { first.requestFocus() } }
    val past = cell.stop <= now
    val onAir = now in cell.start until cell.stop
    val canWatch = onAir || p == null || (past && ch.catchup)
    Box(Modifier.fillMaxSize().background(Tokens.background.copy(alpha = 0.5f)), contentAlignment = Alignment.CenterEnd) {
        Column(
            Modifier.width(520.dp).fillMaxHeight().background(Tokens.popover).padding(40.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ChannelLogo(ch, 48.dp)
                Spacer(Modifier.width(12.dp))
                Text(listOfNotNull(ch.number, ch.name).joinToString("  "), style = MaterialTheme.typography.titleSmall, color = Tokens.mutedForeground, maxLines = 1)
            }
            Text(p?.title ?: stringResource(R.string.livetv_no_info), style = MaterialTheme.typography.headlineSmall, color = Tokens.popoverForeground, maxLines = 3, overflow = TextOverflow.Ellipsis)
            p?.subtitle?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.titleSmall, color = Tokens.popoverForeground) }
            Text(
                listOfNotNull(fmtDay(cell.start), "${fmtTime(cell.start)} – ${fmtTime(cell.stop)}", p?.category, p?.episodeNum).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground,
            )
            if (onAir && p != null) LiveProgress(p.progressAt(now), height = 4.dp)
            p?.description?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = Tokens.popoverForeground, maxLines = 8, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.height(8.dp))
            val watchLabel = when {
                onAir || p == null -> stringResource(R.string.livetv_watch_live)
                past && ch.catchup -> stringResource(R.string.livetv_watch_catchup)
                past -> stringResource(R.string.livetv_catchup_unavailable)
                else -> stringResource(R.string.livetv_starts_at, fmtTime(cell.start))
            }
            PrimaryButton(watchLabel, { onWatch(p) }, Modifier.focusRequester(first), icon = MixaiIcons.LiveTv, enabled = canWatch)
            if (p != null && !past) {
                SecondaryButton(stringResource(R.string.livetv_record), { onRecord(p) }, icon = MixaiIcons.Record)
                SecondaryButton(stringResource(R.string.livetv_record_series), { onSeries(p) }, icon = MixaiIcons.Record)
            }
            SecondaryButton(stringResource(R.string.livetv_close), onClose)
        }
    }
}
