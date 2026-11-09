package ro.mixai.keybpm.wear

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.AmbientMode
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.foundation.pager.rememberPagerState
import androidx.wear.compose.foundation.pager.VerticalPager
import androidx.wear.compose.foundation.rememberAmbientModeManager
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.SwitchButton
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import androidx.wear.compose.material3.VerticalPagerScaffold
import kotlinx.coroutines.delay
import ro.mixai.listen.Harmony
import ro.mixai.mobile.theme.Tokens

/** Pages: Live (key ring + BPM + tap) → Controls (listen / haptics / tap reset). */
@Composable
fun WearRoot(listen: WearListen, onStart: () -> Unit) {
    val ui by listen.ui.collectAsState()
    val pager = rememberPagerState(pageCount = { 2 })
    AppScaffold(timeText = { TimeText() }) {
        VerticalPagerScaffold(pagerState = pager) {
            VerticalPager(state = pager) { page ->
                when (page) {
                    0 -> LivePage(listen, ui, onStart)
                    else -> ControlsPage(listen, ui, onStart)
                }
            }
        }
    }
}

@Composable
private fun LivePage(listen: WearListen, ui: WearUi, onStart: () -> Unit) {
    val ambient = rememberAmbientModeManager().currentAmbientMode is AmbientMode.Ambient
    val pulse = remember { Animatable(0f) }
    // Visual beat (not in ambient): one pulse per beat from the shared clock, read in the draw phase only.
    LaunchedEffect(ui.active, ui.shownBpm, ambient) {
        if (ambient || ui.shownBpm == null) return@LaunchedEffect
        while (true) {
            val wait = listen.clock.untilNext(android.os.SystemClock.uptimeMillis().toDouble()) ?: break
            delay(wait.toLong().coerceAtLeast(16))
            pulse.snapTo(1f)
            pulse.animateTo(0f, tween(160))
        }
    }
    val keyText = ui.keyIndex?.let { Harmony.camelot(it) } ?: "—"
    val keyName = ui.keyIndex?.let { Harmony.keyName(it) }
    val bpmText = ui.shownBpm?.let { "%.1f".format(it) } ?: "—"
    val cd = stringResource(R.string.cd_live, keyName ?: "—", bpmText)
    ScreenScaffold {
        Box(
            Modifier
                .fillMaxSize()
                .semantics { contentDescription = cd }
                // Wrist tap tempo: tap anywhere on the live page in time with the music.
                .clickable(onClickLabel = stringResource(R.string.tap_tempo)) { listen.tap() },
            contentAlignment = Alignment.Center,
        ) {
            if (!ambient) KeyRing(ui.keyIndex, { pulse.value })
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    keyText, fontSize = 40.sp, fontWeight = FontWeight.Bold,
                    color = if (ui.keyLocked || ambient) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
                if (keyName != null) Text(keyName, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    bpmText, fontSize = 26.sp, fontWeight = FontWeight.SemiBold,
                    color = if (ui.tapBpm != null) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    when {
                        ui.tapBpm != null -> stringResource(R.string.bpm_tapped)
                        ui.source == Source.PHONE -> stringResource(R.string.from_phone)
                        ui.source == Source.WATCH && ui.levelLow -> stringResource(R.string.level_low)
                        ui.source == Source.WATCH -> stringResource(R.string.bpm_label)
                        else -> stringResource(R.string.tap_hint)
                    },
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 24.dp),
                )
                ui.title?.takeIf { ui.source == Source.PHONE }?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 30.dp))
                }
                if (!ui.active && !ambient) {
                    Button(onClick = onStart, modifier = Modifier.padding(top = 4.dp)) { Text(stringResource(R.string.listen)) }
                }
                ui.keyChange?.let { k ->
                    Text(
                        stringResource(R.string.key_changed, Harmony.camelot(k)),
                        style = MaterialTheme.typography.labelSmall, color = Tokens.warning,
                        modifier = Modifier.clickable { listen.dismissKeyChange() }.semantics { liveRegion = LiveRegionMode.Assertive },
                    )
                }
                if (ui.micFailed) Text(stringResource(R.string.mic_failed), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

/** Camelot ring around the bezel: 12 segments per mode, the current key lit in its token colour, beat on the stroke. */
@Composable
private fun KeyRing(keyIndex: Int?, pulse: () -> Float) {
    Canvas(Modifier.fillMaxSize().padding(4.dp)) {
        val p = pulse()
        val stroke = 7.dp.toPx()
        val r = size.minDimension / 2f - stroke
        val c = Offset(size.width / 2f, size.height / 2f)
        val seg = 30f
        val minor = keyIndex?.let { Harmony.isMinor(it) } ?: true
        val active = keyIndex?.let { Harmony.camelotNumber(it) }
        for (n in 1..12) {
            val base = if (minor) Tokens.keyMinor[n - 1] else Tokens.keyMajor[n - 1]
            val on = active == n
            val near = keyIndex != null && Harmony.wheelDistance(keyIndex, RING_INDEX[if (minor) 1 else 0][n - 1]) <= 1
            val alpha = when { on -> 1f; near -> 0.6f; active == null -> 0.35f; else -> 0.15f }
            drawArc(
                color = base.copy(alpha = alpha),
                startAngle = n * seg - 90f - seg / 2f + 2f,
                sweepAngle = seg - 4f,
                useCenter = false,
                topLeft = Offset(c.x - r, c.y - r),
                size = Size(r * 2, r * 2),
                style = Stroke(width = if (on) stroke * (1.4f + 0.5f * p) else stroke),
            )
        }
        drawCircle(Color.White.copy(alpha = 0.06f + 0.25f * p), radius = r * 0.12f, center = Offset(c.x, c.y + r * 0.72f))
    }
}

/** Key index for each Camelot number, [0] = major (B), [1] = minor (A). */
private val RING_INDEX: List<List<Int>> = listOf(false, true).map { minor ->
    (1..12).map { n -> (0 until 24).first { Harmony.camelotNumber(it) == n && Harmony.isMinor(it) == minor } }
}

@Composable
private fun ControlsPage(listen: WearListen, ui: WearUi, onStart: () -> Unit) {
    val state = rememberTransformingLazyColumnState()
    val ctx = LocalContext.current
    ScreenScaffold(scrollState = state) { padding ->
        TransformingLazyColumn(state = state, contentPadding = padding) {
            item { ListHeader { Text(stringResource(R.string.app_short)) } }
            item {
                if (ui.source == Source.WATCH) {
                    FilledTonalButton(onClick = { listen.stopWatch() }, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.stop)) })
                } else {
                    Button(onClick = onStart, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.listen_watch)) })
                }
            }
            item {
                SwitchButton(
                    checked = ui.haptics, onCheckedChange = { listen.setHaptics(it) }, modifier = Modifier.fillMaxWidth(),
                    label = { Text(stringResource(R.string.haptic_beat)) },
                    secondaryLabel = { Text(stringResource(R.string.haptic_beat_hint)) },
                )
            }
            if (ui.tapBpm != null) item {
                FilledTonalButton(onClick = { listen.clearTap() }, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.tap_clear)) })
            }
            item {
                Text(
                    stringResource(if (ui.phoneListening) R.string.phone_listening else R.string.phone_hint),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                )
            }
            item {
                Box(Modifier.padding(top = 4.dp).background(MaterialTheme.colorScheme.surfaceContainer, CircleShape).padding(horizontal = 12.dp, vertical = 4.dp)) {
                    Text(ctx.getString(R.string.version, BuildConfig.VERSION_NAME), style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}
