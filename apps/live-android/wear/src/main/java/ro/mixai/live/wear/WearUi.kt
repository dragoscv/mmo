package ro.mixai.live.wear

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.foundation.pager.VerticalPager
import androidx.wear.compose.foundation.pager.rememberPagerState
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import androidx.wear.compose.material3.VerticalPagerScaffold
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import ro.mixai.live.core.ClientMsg
import ro.mixai.live.core.ClientState
import ro.mixai.live.core.Phase
import ro.mixai.live.core.Role
import ro.mixai.live.core.linToDb
import ro.mixai.live.core.meterFill
import ro.mixai.live.core.midiName
import ro.mixai.mobile.theme.Tokens
import kotlin.math.abs
import kotlin.math.max

/** Pages: Scenes (level ring, part, prev/next) → Controls (mute/panic) → Tuner → Engine. */
@Composable
fun WearRoot(app: LiveWearApp) {
    val state by app.client.state.collectAsState()
    val haptic = LocalHapticFeedback.current
    LaunchedEffect(state.sceneChanges) { if (state.sceneChanges > 0) haptic.performHapticFeedback(HapticFeedbackType.Confirm) }
    val pager = rememberPagerState(pageCount = { 4 })
    AppScaffold(timeText = { TimeText() }) {
        VerticalPagerScaffold(pagerState = pager) {
            VerticalPager(state = pager) { page ->
                when (page) {
                    0 -> ScenesPage(app, state)
                    1 -> ControlsPage(app, state)
                    2 -> TunerPage(app)
                    else -> EnginePage(app, state)
                }
            }
        }
    }
}

@Composable
private fun statusLine(s: ClientState): String? = when (s.phase) {
    Phase.IDLE -> stringResource(R.string.not_paired)
    Phase.CONNECTING -> stringResource(R.string.connecting)
    Phase.RECONNECTING -> stringResource(R.string.reconnecting)
    Phase.UNAUTHORIZED -> stringResource(R.string.unauthorized)
    Phase.UPDATE_REQUIRED -> stringResource(R.string.update_required)
    Phase.CONNECTED -> if (s.role == Role.VIEWER) stringResource(R.string.viewer_only) else null
}

@Composable
private fun ScenesPage(app: LiveWearApp, s: ClientState) {
    val canGo = s.can(Role.PERFORMER)
    ScreenScaffold {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            LevelRing(app)
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(horizontal = 22.dp)) {
                val part = s.session?.currentPart?.name ?: s.session?.preset?.ifBlank { null }
                Text(
                    part ?: "—", fontSize = 22.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    color = if (s.session?.mix?.mute == true) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    s.session?.currentSong?.title ?: stringResource(R.string.no_song),
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                statusLine(s)?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (canGo) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    val prev = stringResource(R.string.prev)
                    val next = stringResource(R.string.next)
                    FilledTonalButton(
                        onClick = { app.client.send(ClientMsg.Prev) },
                        modifier = Modifier.size(width = 64.dp, height = 52.dp).semantics { contentDescription = prev },
                    ) {
                        Text("◀", fontSize = 20.sp)
                    }
                    Button(
                        onClick = { app.client.send(ClientMsg.Next) },
                        modifier = Modifier.size(width = 64.dp, height = 52.dp).semantics { contentDescription = next },
                    ) {
                        Text("▶", fontSize = 20.sp)
                    }
                }
            }
        }
    }
}

/** Input level around the bezel, drawn per frame in the draw phase (no recomposition). */
@Composable
private fun LevelRing(app: LiveWearApp) {
    val tick = remember { mutableIntStateOf(0) }
    val level = remember { FloatArray(1) }
    LaunchedEffect(Unit) {
        var last = 0L
        while (true) withFrameNanos { t ->
            val dt = if (last == 0L) 0.016f else ((t - last) / 1e9f).coerceIn(0f, 0.1f)
            last = t
            val target = meterFill(linToDb(app.client.meters.value?.inPeak ?: 0f))
            level[0] = if (target > level[0]) target else max(target, level[0] - dt / 3f)
            tick.intValue = (tick.intValue + 1) and 0xFFFF
        }
    }
    val track = MaterialTheme.colorScheme.outlineVariant
    val ok = Tokens.success
    val hot = Tokens.warning
    val cd = stringResource(R.string.cd_level)
    Canvas(Modifier.fillMaxSize().padding(3.dp).semantics { contentDescription = cd }) {
        tick.intValue
        val stroke = 6.dp.toPx()
        val r = size.minDimension / 2f - stroke
        val tl = Offset(size.width / 2f - r, size.height / 2f - r)
        val sz = Size(r * 2, r * 2)
        drawArc(track, 135f, 270f, false, tl, sz, style = Stroke(stroke, cap = StrokeCap.Round))
        val sweep = 270f * level[0]
        if (sweep > 0.5f) drawArc(if (level[0] > 0.8f) hot else ok, 135f, sweep, false, tl, sz, style = Stroke(stroke, cap = StrokeCap.Round))
    }
}

@Composable
private fun ControlsPage(app: LiveWearApp, s: ClientState) {
    val list = rememberTransformingLazyColumnState()
    val canGo = s.can(Role.PERFORMER)
    val muted = s.session?.mix?.mute == true
    val haptic = LocalHapticFeedback.current
    ScreenScaffold(scrollState = list) { pad ->
        TransformingLazyColumn(state = list, contentPadding = pad) {
            item { ListHeader { Text(s.session?.currentPart?.name ?: stringResource(R.string.app_short)) } }
            if (canGo) {
                item {
                    Button(
                        onClick = { app.client.send(ClientMsg.SetMix(mute = !muted)) },
                        colors = if (muted) ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError)
                        else ButtonDefaults.filledTonalButtonColors(),
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text(stringResource(if (muted) R.string.unmute else R.string.mute), fontWeight = FontWeight.Bold) },
                    )
                }
                item {
                    // Long-press only: a stray tap on the wrist must never kill the show.
                    Button(
                        onClick = {},
                        onLongClick = {
                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                            app.client.send(ClientMsg.Panic)
                        },
                        onLongClickLabel = stringResource(R.string.panic),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text(stringResource(R.string.panic), fontWeight = FontWeight.Bold) },
                        secondaryLabel = { Text(stringResource(R.string.panic_hold)) },
                    )
                }
                item {
                    FilledTonalButton(onClick = { app.client.send(ClientMsg.Next) }, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.next)) })
                }
                item {
                    FilledTonalButton(onClick = { app.client.send(ClientMsg.Prev) }, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.prev)) })
                }
            } else {
                item { Text(statusLine(s) ?: stringResource(R.string.viewer_only), textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
            }
        }
    }
}

@Composable
private fun TunerPage(app: LiveWearApp) {
    val noteFlow = remember { app.client.meters.map { m -> m?.tune?.let { midiName(it.target?.toFloat() ?: it.midi) } }.distinctUntilChanged() }
    val note by noteFlow.collectAsState(initial = null)
    val centsFlow = remember { app.client.meters.map { m -> m?.tune?.cents?.let { Math.round(it / 2f) * 2f } }.distinctUntilChanged() }
    val coarseCents by centsFlow.collectAsState(initial = null)
    val tick = remember { mutableIntStateOf(0) }
    val cents = remember { FloatArray(1) }
    LaunchedEffect(Unit) {
        while (true) withFrameNanos {
            val target = (app.client.meters.value?.tune?.cents ?: 0f).coerceIn(-50f, 50f)
            cents[0] += (target - cents[0]) * 0.2f
            tick.intValue = (tick.intValue + 1) and 0xFFFF
        }
    }
    val ok = Tokens.success
    val warn = Tokens.warning
    val track = MaterialTheme.colorScheme.outlineVariant
    ScreenScaffold {
        Column(Modifier.fillMaxSize().padding(horizontal = 20.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.tuner), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(note ?: stringResource(R.string.no_tune), fontSize = 34.sp, fontWeight = FontWeight.Bold)
            coarseCents?.takeIf { note != null }?.let {
                Text(stringResource(R.string.cents, it), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Canvas(Modifier.fillMaxWidth().height(28.dp)) {
                tick.intValue
                val mid = size.width / 2
                drawLine(track, Offset(0f, size.height / 2), Offset(size.width, size.height / 2), 2.dp.toPx())
                drawLine(track, Offset(mid, 0f), Offset(mid, size.height), 2.dp.toPx())
                if (note != null) {
                    val x = mid + cents[0] / 50f * (size.width / 2 - 6f)
                    drawLine(if (abs(cents[0]) <= 5f) ok else warn, Offset(x, 0f), Offset(x, size.height), 4.dp.toPx(), StrokeCap.Round)
                }
            }
        }
    }
}

@Composable
private fun EnginePage(app: LiveWearApp, s: ClientState) {
    val list = rememberTransformingLazyColumnState()
    val engines by app.store.engines.collectAsState(initial = emptyList())
    ScreenScaffold(scrollState = list) { pad ->
        TransformingLazyColumn(state = list, contentPadding = pad) {
            item { ListHeader { Text(stringResource(R.string.engine)) } }
            if (engines.isEmpty()) {
                item { Text(stringResource(R.string.not_paired), textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) }
            }
            engines.forEach { e ->
                item(key = e.key) {
                    val active = s.engine?.key == e.key && s.phase != Phase.IDLE
                    FilledTonalButton(
                        onClick = { if (active) app.client.disconnect() else app.use(e) },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text(e.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        secondaryLabel = { Text(stringResource(if (active) R.string.disconnect else R.string.connect)) },
                    )
                }
            }
        }
    }
}
