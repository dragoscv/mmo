package ro.mixai.keybpm.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import ro.mixai.keybpm.ListenUi
import ro.mixai.keybpm.R
import ro.mixai.mobile.theme.Mixai
import uniffi.mixai_listen_ffi.keyLabel

/** "1:02:03" / "4:05" from a duration. */
internal fun formatElapsed(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}

/**
 * Stage mode (WP18-19): black background, the key and BPM as large as the screen allows (both orientations), set
 * timer since listening started, the key-change alert as a full-width warning band. Tap anywhere toggles the
 * half/double tempo; Back or "Exit" leaves. The screen stays on while listening (handled by the activity).
 */
/** Night palette: deep red (red channel 0.69) derived from a named colour, so no hex literal (hex gate). */
private val NightRed = Color.Red.copy(red = 0.69f)

@Composable
fun StageScreen(
    ui: ListenUi,
    onCycleTempo: () -> Unit,
    onDismissChange: () -> Unit,
    onExit: () -> Unit,
    onNight: (Boolean) -> Unit = {},
    onDnd: (Boolean) -> Unit = {},
) {
    BackHandler(onBack = onExit)
    val context = LocalContext.current
    // Do not disturb while stage mode is open (priority only), restoring the user's filter on exit.
    DisposableEffect(ui.stageDnd) {
        val nm: android.app.NotificationManager? = context.getSystemService(android.app.NotificationManager::class.java)
        // Only touch the filter when it is "all"; a user already in DND / alarms-only keeps theirs.
        val changed = nm != null && ui.stageDnd && nm.isNotificationPolicyAccessGranted &&
            nm.currentInterruptionFilter == android.app.NotificationManager.INTERRUPTION_FILTER_ALL
        if (changed) nm.setInterruptionFilter(android.app.NotificationManager.INTERRUPTION_FILTER_PRIORITY)
        onDispose {
            if (changed && nm.isNotificationPolicyAccessGranted) {
                nm.setInterruptionFilter(android.app.NotificationManager.INTERRUPTION_FILTER_ALL)
            }
        }
    }
    val toggleDnd: () -> Unit = {
        val nm = context.getSystemService(android.app.NotificationManager::class.java)
        if (!ui.stageDnd && nm?.isNotificationPolicyAccessGranted != true) {
            runCatching {
                context.startActivity(
                    android.content.Intent(android.provider.Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
                        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        } else {
            onDnd(!ui.stageDnd)
        }
    }
    val fg = if (ui.stageNight) NightRed else Color.White
    val warn = if (ui.stageNight) NightRed else Mixai.colors.warning
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(ui.startedAtMillis) {
        while (ui.startedAtMillis != null) { now = System.currentTimeMillis(); delay(1000) }
    }
    LaunchedEffect(ui.keyChange) {
        if (ui.keyChange != null) { delay(8_000); onDismissChange() }
    }
    val bg by animateColorAsState(if (ui.keyChange != null) warn.copy(alpha = 0.25f) else Color.Black, tween(300), label = "stageBg")
    val key = ui.snapshot?.key
    val keyText = key?.let { keyLabel(it.key.index, ui.notation) } ?: "—"
    val bpmText = ui.bpm?.let { "%.1f".format(it) } ?: "—"
    BoxWithConstraints(Modifier.fillMaxSize().background(bg).clickable(enabled = ui.snapshot?.tempo != null, onClick = onCycleTempo)) {
        val landscape = maxWidth > maxHeight
        val big = (if (landscape) maxHeight.value * 0.42f else maxWidth.value * 0.30f).sp
        Column(Modifier.fillMaxSize().padding(16.dp)) {
            Row(Modifier, verticalAlignment = Alignment.CenterVertically) {
                Text(
                    ui.startedAtMillis?.let { stringResource(R.string.stage_timer, formatElapsed(now - it)) } ?: stringResource(R.string.stage_idle),
                    color = fg.copy(alpha = 0.7f),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                StageToggle(stringResource(R.string.stage_night), ui.stageNight, fg) { onNight(!ui.stageNight) }
                StageToggle(stringResource(R.string.stage_dnd), ui.stageDnd, fg, toggleDnd)
                TextButton(onClick = onExit) { Text(stringResource(R.string.stage_exit), color = fg) }
            }
            ui.keyChange?.let {
                Text(
                    stringResource(R.string.key_changed, it),
                    color = warn,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
                )
            }
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                val content: @Composable () -> Unit = {
                    StageValue(stringResource(R.string.key_label), keyText, big, locked = key?.locked == true, fg)
                    StageValue(stringResource(R.string.bpm_label), bpmText, big, locked = ui.snapshot?.tempo?.locked == true, fg)
                }
                if (landscape) Row(horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) { content() }
                else Column(verticalArrangement = Arrangement.spacedBy(24.dp), horizontalAlignment = Alignment.CenterHorizontally) { content() }
            }
        }
    }
}

@Composable
private fun StageToggle(label: String, on: Boolean, fg: Color, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier.semantics { toggleableState = androidx.compose.ui.state.ToggleableState(on) },
    ) {
        Text(label, color = if (on) fg else fg.copy(alpha = 0.5f), fontWeight = if (on) FontWeight.Bold else FontWeight.Normal)
    }
}

@Composable
private fun StageValue(label: String, value: String, size: androidx.compose.ui.unit.TextUnit, locked: Boolean, fg: Color = Color.White) {
    Column(Modifier.padding(horizontal = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, color = fg.copy(alpha = 0.6f), style = MaterialTheme.typography.titleLarge)
        Text(
            value,
            color = if (locked) fg else fg.copy(alpha = 0.55f),
            fontSize = size,
            lineHeight = size,
            fontWeight = FontWeight.Black,
            maxLines = 1,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
}
