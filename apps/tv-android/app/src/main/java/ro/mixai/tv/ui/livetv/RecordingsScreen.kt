package ro.mixai.tv.ui.livetv

import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import ro.mixai.tv.R
import ro.mixai.tv.data.LiveTvRule
import ro.mixai.tv.data.generated.LiveTvRecording
import ro.mixai.tv.player.PlayRequest
import ro.mixai.tv.ui.components.ConfirmDialog
import ro.mixai.tv.ui.components.EmptyState
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.IconActionButton
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

private enum class RecTab { Scheduled, Recorded, Rules }

private sealed interface PendingDelete {
    data class Rec(val r: LiveTvRecording) : PendingDelete
    data class Rule(val r: LiveTvRule) : PendingDelete
}

/** DVR: Scheduled / Recorded / Rules with status chips, cancel/delete (confirmed), play recorded files. */
@Composable
fun RecordingsScreen(deps: ScreenDeps, nav: Navigator) {
    val repo = deps.liveTv
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tab by rememberSaveable { mutableStateOf(RecTab.Scheduled) }
    var recordings by remember { mutableStateOf<List<LiveTvRecording>?>(null) }
    var rules by remember { mutableStateOf<List<LiveTvRule>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var pending by remember { mutableStateOf<PendingDelete?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    val errGeneric = stringResource(R.string.livetv_error_load)
    val tabFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(80); runCatching { tabFocus.requestFocus() } }

    LaunchedEffect(reload) {
        error = null
        try {
            recordings = repo.recordings()
            rules = runCatching { repo.rules() }.getOrDefault(emptyList())
        } catch (e: Exception) { error = e.message ?: errGeneric }
    }
    // Live status while something records or is about to.
    LaunchedEffect(recordings) {
        if (recordings.orEmpty().any { it.status == "recording" }) { delay(15_000); reload++ }
    }
    LaunchedEffect(notice) { if (notice != null) { delay(3_000); notice = null } }

    fun playRecording(r: LiveTvRecording) {
        val path = r.path ?: return
        scope.launch {
            try {
                val raw = deps.api.getJson("/video/lookup?path=" + deps.api.encode(path))
                val fileId = Json.parseToJsonElement(raw).jsonObject["fileId"]?.jsonPrimitive?.content
                    ?: throw IllegalStateException("no fileId")
                val info = deps.api.fileInfo(fileId)
                nav.push(Route.Play(PlayRequest.Video(info, hls = true), resumeMs = 0L, from = nav.current))
            } catch (e: Exception) {
                notice = context.getString(R.string.livetv_play_recording_failed, e.message ?: "")
            }
        }
    }

    Column(Modifier.fillMaxSize().padding(horizontal = MixaiFocus.overscan, vertical = MixaiFocus.overscanTop), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(stringResource(R.string.livetv_recordings), style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground)
        val all = recordings
        val scheduled = all.orEmpty().filter { it.status == "scheduled" || it.status == "recording" }.sortedBy { it.start }
        val recorded = all.orEmpty().filter { it.status == "done" || it.status == "failed" || it.status == "cancelled" }.sortedByDescending { it.start }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Pill("${stringResource(R.string.livetv_tab_scheduled)} · ${scheduled.size}", tab == RecTab.Scheduled, Modifier.focusRequester(tabFocus)) { tab = RecTab.Scheduled }
            Pill("${stringResource(R.string.livetv_tab_recorded)} · ${recorded.size}", tab == RecTab.Recorded) { tab = RecTab.Recorded }
            Pill("${stringResource(R.string.livetv_tab_rules)} · ${rules.size}", tab == RecTab.Rules) { tab = RecTab.Rules }
        }
        when {
            error != null -> ErrorState(error!!, onRetry = { reload++ })
            all == null -> LoadingState(rows = 2, hero = false)
            tab == RecTab.Rules -> if (rules.isEmpty()) {
                EmptyState(MixaiIcons.Record, stringResource(R.string.livetv_no_rules), stringResource(R.string.livetv_no_rules_hint), focusAction = false)
            } else LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
                items(rules, key = { it.id }) { r -> RuleRow(r) { pending = PendingDelete.Rule(r) } }
            }
            else -> {
                val list = if (tab == RecTab.Scheduled) scheduled else recorded
                if (list.isEmpty()) {
                    EmptyState(
                        MixaiIcons.Record,
                        stringResource(if (tab == RecTab.Scheduled) R.string.livetv_no_scheduled else R.string.livetv_no_recorded),
                        stringResource(R.string.livetv_no_scheduled_hint),
                        focusAction = false,
                    )
                } else LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
                    items(list, key = { it.id }) { r ->
                        RecordingRow(r, onPlay = if (r.status == "done" && r.path != null) ({ playRecording(r) }) else null) { pending = PendingDelete.Rec(r) }
                    }
                }
            }
        }
    }
    notice?.let { Toast(it) }

    when (val p = pending) {
        is PendingDelete.Rec -> {
            val cancel = p.r.status == "scheduled" || p.r.status == "recording"
            ConfirmDialog(
                title = stringResource(if (cancel) R.string.livetv_cancel_recording_title else R.string.livetv_delete_recording_title, p.r.title),
                message = stringResource(if (cancel) R.string.livetv_cancel_recording_message else R.string.livetv_delete_recording_message),
                confirmLabel = stringResource(if (cancel) R.string.livetv_cancel_recording else R.string.livetv_delete),
                destructive = true, focusDismiss = true,
                onDismiss = { pending = null },
                onConfirm = {
                    pending = null
                    scope.launch { runCatching { repo.deleteRecording(p.r.id) }.onFailure { notice = it.message ?: errGeneric }; reload++ }
                },
            )
        }
        is PendingDelete.Rule -> ConfirmDialog(
            title = stringResource(R.string.livetv_delete_rule_title, p.r.titleMatch),
            message = stringResource(R.string.livetv_delete_rule_message),
            confirmLabel = stringResource(R.string.livetv_delete),
            destructive = true, focusDismiss = true,
            onDismiss = { pending = null },
            onConfirm = {
                pending = null
                scope.launch { runCatching { repo.deleteRule(p.r.id) }.onFailure { notice = it.message ?: errGeneric }; reload++ }
            },
        )
        null -> Unit
    }
}

@Composable
private fun StatusChip(status: String, conflict: Boolean) {
    val (label, bg, fg) = when {
        conflict && status == "scheduled" -> Triple(stringResource(R.string.livetv_status_conflict), Tokens.warning, Tokens.background)
        status == "scheduled" -> Triple(stringResource(R.string.livetv_status_scheduled), Tokens.accent, Tokens.accentForeground)
        status == "recording" -> Triple(stringResource(R.string.livetv_status_recording), Tokens.destructive, Tokens.destructiveForeground)
        status == "done" -> Triple(stringResource(R.string.livetv_status_done), Tokens.success, Tokens.background)
        status == "failed" -> Triple(stringResource(R.string.livetv_status_failed), Tokens.destructive, Tokens.destructiveForeground)
        else -> Triple(stringResource(R.string.livetv_status_cancelled), Tokens.muted, Tokens.mutedForeground)
    }
    Text(label, style = MaterialTheme.typography.labelSmall, color = fg, modifier = Modifier.background(bg, RoundedCornerShape(4.dp)).padding(horizontal = 8.dp, vertical = 3.dp))
}

@Composable
private fun RecordingRow(r: LiveTvRecording, onPlay: (() -> Unit)?, onDelete: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(Tokens.card, RoundedCornerShape(12.dp)).padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusChip(r.status, r.conflict)
                Spacer(Modifier.width(10.dp))
                Text(r.title.ifBlank { r.channelName.orEmpty() }, style = MaterialTheme.typography.titleSmall, color = Tokens.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(
                listOfNotNull(r.channelName, fmtDay(r.start), "${fmtTime(r.start)} – ${fmtTime(r.stop)}", if (r.ruleId != null) stringResource(R.string.livetv_from_rule) else null).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground,
            )
            r.error?.takeIf { r.status == "failed" }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Tokens.destructive, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            if (r.conflict && r.status == "scheduled") Text(stringResource(R.string.livetv_conflict_hint), style = MaterialTheme.typography.bodySmall, color = Tokens.warning)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (onPlay != null) IconActionButton(Icons.Filled.PlayArrow, stringResource(R.string.livetv_play), onPlay)
            IconActionButton(Icons.Filled.Delete, stringResource(R.string.livetv_delete), onDelete)
        }
    }
}

@Composable
private fun RuleRow(r: LiveTvRule, onDelete: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(Tokens.card, RoundedCornerShape(12.dp)).padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(r.titleMatch, style = MaterialTheme.typography.titleSmall, color = Tokens.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val parts = buildList {
                add(stringResource(if (r.channelId == null) R.string.livetv_rule_any_channel else R.string.livetv_rule_one_channel))
                if (r.keepLast > 0) add(stringResource(R.string.livetv_rule_keep, r.keepLast.toInt()))
                if (!r.enabled) add(stringResource(R.string.livetv_source_disabled))
            }
            Text(parts.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground)
        }
        IconActionButton(Icons.Filled.Delete, stringResource(R.string.livetv_delete), onDelete)
    }
}
