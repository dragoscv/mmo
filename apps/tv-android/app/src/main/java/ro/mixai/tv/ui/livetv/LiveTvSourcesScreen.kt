package ro.mixai.tv.ui.livetv

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.tv.R
import ro.mixai.tv.data.LiveTvSourceInput
import ro.mixai.tv.data.generated.LiveTvSource
import ro.mixai.tv.ui.components.Choice
import ro.mixai.tv.ui.components.ChoiceDialog
import ro.mixai.tv.ui.components.ConfirmDialog
import ro.mixai.tv.ui.components.EmptyState
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.IconActionButton
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.components.TvKeyboard
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

private enum class SourceKind(val wire: String) { M3u("m3u"), Xtream("xtream"), HdHomeRun("hdhomerun") }
private enum class Field { Name, Url, Xmltv, Username, Password }

/**
 * Manage IPTV sources: list with status (channels, last refresh, last error), add (M3U / Xtream /
 * HDHomeRun), test, refresh, delete. Rendered inside [LiveTvScreen]; Back returns to the channels.
 */
@Composable
fun LiveTvSourcesScreen(deps: ScreenDeps, onClose: () -> Unit) {
    val repo = deps.liveTv
    val scope = rememberCoroutineScope()
    var sources by remember { mutableStateOf<List<LiveTvSource>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var adding by rememberSaveable { mutableStateOf(false) }
    var toDelete by remember { mutableStateOf<LiveTvSource?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    val errGeneric = stringResource(R.string.livetv_error_load)

    BackHandler(enabled = !adding) { onClose() }
    LaunchedEffect(reload) {
        error = null
        try { sources = repo.sources() } catch (e: Exception) { error = e.message ?: errGeneric }
    }
    // While a source has never been refreshed (first lineup runs in the background), poll.
    LaunchedEffect(sources) {
        if (sources.orEmpty().any { it.enabled && it.lastRefresh == null && it.lastError == null }) { delay(2_000); reload++ }
    }
    LaunchedEffect(notice) { if (notice != null) { delay(3_500); notice = null } }

    if (adding) {
        AddSourceForm(
            onCancel = { adding = false },
            onSave = { input ->
                runCatching { repo.createSource(input) }
                    .onSuccess { adding = false; reload++ }
                    .map { }
            },
        )
        return
    }

    val okTest = stringResource(R.string.livetv_test_ok)
    val refreshed = stringResource(R.string.livetv_refresh_done)
    val addFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(80); runCatching { addFocus.requestFocus() } }
    Column(Modifier.fillMaxSize().padding(horizontal = MixaiFocus.overscan, vertical = MixaiFocus.overscanTop), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.livetv_sources), style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground)
                Text(stringResource(R.string.livetv_sources_hint), style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground)
            }
            PrimaryButton(stringResource(R.string.livetv_add_source), { adding = true }, Modifier.focusRequester(addFocus), icon = Icons.Filled.Add)
        }
        val list = sources
        when {
            error != null -> ErrorState(error!!, onRetry = { reload++ })
            list == null -> LoadingState(rows = 2, hero = false)
            list.isEmpty() -> EmptyState(
                icon = MixaiIcons.LiveTv,
                title = stringResource(R.string.livetv_empty_title),
                message = stringResource(R.string.livetv_empty_message),
                focusAction = false,
            )
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(bottom = 32.dp)) {
                items(list, key = { it.id }) { s ->
                    SourceRow(
                        s, busy = busy == s.id,
                        onTest = {
                            busy = s.id
                            scope.launch {
                                runCatching { repo.testSource(s.id) }
                                    .onSuccess { t -> notice = if (t.ok) okTest.format(t.channelCount.toInt()) else (t.error ?: errGeneric) }
                                    .onFailure { notice = it.message ?: errGeneric }
                                busy = null
                            }
                        },
                        onRefresh = {
                            busy = s.id
                            scope.launch {
                                runCatching { repo.refreshSource(s.id) }
                                    .onSuccess { notice = refreshed }
                                    .onFailure { notice = it.message ?: errGeneric }
                                busy = null
                                reload++
                            }
                        },
                        onDelete = { toDelete = s },
                    )
                }
            }
        }
    }
    notice?.let { Toast(it) }
    toDelete?.let { s ->
        ConfirmDialog(
            title = stringResource(R.string.livetv_delete_source_title, s.name),
            message = stringResource(R.string.livetv_delete_source_message),
            confirmLabel = stringResource(R.string.livetv_delete),
            destructive = true,
            focusDismiss = true,
            onDismiss = { toDelete = null },
            onConfirm = {
                toDelete = null
                scope.launch {
                    runCatching { repo.deleteSource(s.id) }.onFailure { notice = it.message ?: errGeneric }
                    reload++
                }
            },
        )
    }
}

@Composable
private fun SourceRow(s: LiveTvSource, busy: Boolean, onTest: () -> Unit, onRefresh: () -> Unit, onDelete: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(Tokens.card, RoundedCornerShape(12.dp)).padding(horizontal = 18.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(s.name, style = MaterialTheme.typography.titleMedium, color = Tokens.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.width(10.dp))
                Text(kindLabel(s.kind), style = MaterialTheme.typography.labelSmall, color = Tokens.accentForeground,
                    modifier = Modifier.background(Tokens.accent, RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
            }
            Text(sourceStatus(s), style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground)
            when {
                busy -> Text(stringResource(R.string.livetv_working), style = MaterialTheme.typography.bodySmall, color = Tokens.info)
                s.lastError != null -> Text(stringResource(R.string.livetv_source_error, s.lastError), style = MaterialTheme.typography.bodySmall, color = Tokens.destructive, maxLines = 2, overflow = TextOverflow.Ellipsis)
                s.enabled && s.lastRefresh == null -> Text(stringResource(R.string.livetv_source_pending), style = MaterialTheme.typography.bodySmall, color = Tokens.info)
                s.guideError != null -> Text(stringResource(R.string.livetv_guide_error, s.guideError), style = MaterialTheme.typography.bodySmall, color = Tokens.warning, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SecondaryButton(stringResource(R.string.livetv_test), onTest, enabled = !busy)
            IconActionButton(Icons.Filled.Refresh, stringResource(R.string.livetv_refresh), onRefresh, enabled = !busy)
            IconActionButton(Icons.Filled.Delete, stringResource(R.string.livetv_delete), onDelete, enabled = !busy)
        }
    }
}

@Composable
private fun kindLabel(kind: String): String = when (kind) {
    "xtream" -> stringResource(R.string.livetv_kind_xtream)
    "hdhomerun" -> stringResource(R.string.livetv_kind_hdhomerun)
    else -> stringResource(R.string.livetv_kind_m3u)
}

@Composable
internal fun sourceStatus(s: LiveTvSource): String {
    val parts = mutableListOf(stringResource(R.string.livetv_source_channels, s.channelCount.toInt()))
    s.lastRefresh?.let { parts += stringResource(R.string.livetv_source_refreshed, fmtDay(it) + " " + fmtTime(it)) }
    if (!s.enabled) parts += stringResource(R.string.livetv_source_disabled)
    return parts.joinToString(" · ")
}

/**
 * Add-source form: kind (ChoiceDialog), then each text field edited with the on-screen [TvKeyboard]
 * (one field at a time — the keyboard sits on the right, fields on the left).
 */
@Composable
private fun AddSourceForm(onCancel: () -> Unit, onSave: suspend (LiveTvSourceInput) -> Result<Unit>) {
    val scope = rememberCoroutineScope()
    var kind by rememberSaveable { mutableStateOf(SourceKind.M3u) }
    var name by rememberSaveable { mutableStateOf("") }
    var url by rememberSaveable { mutableStateOf("") }
    var xmltv by rememberSaveable { mutableStateOf("") }
    var username by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var editing by rememberSaveable { mutableStateOf<Field?>(null) }
    var pickKind by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val needUrl = stringResource(R.string.livetv_form_need_url)
    val errGeneric = stringResource(R.string.livetv_error_load)
    val kindFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(80); runCatching { kindFocus.requestFocus() } }

    BackHandler(enabled = !pickKind) { if (editing != null) editing = null else onCancel() }

    fun value(f: Field) = when (f) { Field.Name -> name; Field.Url -> url; Field.Xmltv -> xmltv; Field.Username -> username; Field.Password -> password }
    fun set(f: Field, v: String) {
        when (f) {
            Field.Name -> name = v
            Field.Url -> url = v
            Field.Xmltv -> xmltv = v
            Field.Username -> username = v
            Field.Password -> password = v
        }
    }
    val fields = buildList {
        add(Field.Name); add(Field.Url)
        if (kind != SourceKind.HdHomeRun) add(Field.Xmltv)
        if (kind == SourceKind.Xtream) { add(Field.Username); add(Field.Password) }
    }

    Row(Modifier.fillMaxSize().padding(horizontal = MixaiFocus.overscan, vertical = MixaiFocus.overscanTop), horizontalArrangement = Arrangement.spacedBy(32.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.livetv_add_source), style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground)
            Text(stringResource(R.string.livetv_form_legal), style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground)
            Spacer(Modifier.height(4.dp))
            FormRow(stringResource(R.string.livetv_form_kind), kindLabel(kind.wire), selected = false, modifier = Modifier.focusRequester(kindFocus)) { pickKind = true }
            fields.forEach { f ->
                val shown = if (f == Field.Password && value(f).isNotEmpty()) "•".repeat(value(f).length) else value(f)
                FormRow(fieldLabel(f, kind), shown.ifEmpty { fieldHint(f, kind) }, selected = editing == f, placeholder = value(f).isEmpty()) { editing = f }
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Tokens.destructive) }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PrimaryButton(stringResource(if (saving) R.string.livetv_working else R.string.livetv_save), enabled = !saving, onClick = {
                    if (url.isBlank()) { error = needUrl; return@PrimaryButton }
                    saving = true; error = null
                    scope.launch {
                        val input = LiveTvSourceInput(
                            kind = kind.wire,
                            name = name.trim().ifBlank { null },
                            url = url.trim(),
                            xmltvUrl = xmltv.trim().ifBlank { null },
                            username = username.trim().ifBlank { null },
                            password = password.ifBlank { null },
                            enabled = true,
                        )
                        onSave(input).onFailure { error = it.message ?: errGeneric }
                        saving = false
                    }
                })
                SecondaryButton(stringResource(R.string.wp16_cancel), onCancel)
            }
        }
        Box(Modifier.weight(1f)) {
            val f = editing
            if (f != null) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(fieldLabel(f, kind), style = MaterialTheme.typography.titleMedium, color = Tokens.foreground)
                    Text(
                        (if (f == Field.Password) "•".repeat(value(f).length) else value(f)).ifEmpty { " " } + "▏",
                        style = MaterialTheme.typography.titleSmall, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.fillMaxWidth().background(Tokens.input, RoundedCornerShape(8.dp)).padding(12.dp),
                    )
                    TvKeyboard(text = value(f), onTextChange = { set(f, it) }, keySize = 44.dp, maxLength = 500)
                    SecondaryButton(stringResource(R.string.livetv_form_done), { editing = null })
                    Text(stringResource(R.string.livetv_form_keyboard_hint), style = MaterialTheme.typography.labelSmall, color = Tokens.mutedForeground)
                }
            } else {
                Text(stringResource(R.string.livetv_form_pick_field), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground, modifier = Modifier.align(Alignment.Center))
            }
        }
    }
    ChoiceDialog(
        title = stringResource(R.string.livetv_form_kind),
        visible = pickKind,
        options = listOf(
            Choice(SourceKind.M3u, stringResource(R.string.livetv_kind_m3u), stringResource(R.string.livetv_kind_m3u_hint)),
            Choice(SourceKind.Xtream, stringResource(R.string.livetv_kind_xtream), stringResource(R.string.livetv_kind_xtream_hint)),
            Choice(SourceKind.HdHomeRun, stringResource(R.string.livetv_kind_hdhomerun), stringResource(R.string.livetv_kind_hdhomerun_hint)),
        ),
        selected = kind,
        onPick = { kind = it; pickKind = false },
        onDismiss = { pickKind = false },
    )
}

@Composable
private fun fieldLabel(f: Field, kind: SourceKind): String = when (f) {
    Field.Name -> stringResource(R.string.livetv_form_name)
    Field.Url -> stringResource(
        when (kind) { SourceKind.M3u -> R.string.livetv_form_url_m3u; SourceKind.Xtream -> R.string.livetv_form_url_xtream; SourceKind.HdHomeRun -> R.string.livetv_form_url_hdhr },
    )
    Field.Xmltv -> stringResource(R.string.livetv_form_xmltv)
    Field.Username -> stringResource(R.string.livetv_form_username)
    Field.Password -> stringResource(R.string.livetv_form_password)
}

@Composable
private fun fieldHint(f: Field, kind: SourceKind): String = when (f) {
    Field.Url -> if (kind == SourceKind.HdHomeRun) "http://192.168.1.50" else "https://…"
    Field.Xmltv -> stringResource(R.string.livetv_form_optional)
    else -> stringResource(R.string.livetv_form_empty)
}

@Composable
private fun FormRow(label: String, value: String, selected: Boolean, placeholder: Boolean = false, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(10.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (selected) Tokens.accent else Tokens.card,
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.02f),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.width(180.dp), maxLines = 1)
            Text(
                value, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).let { if (placeholder) it.padding(0.dp) else it },
                color = if (placeholder) Tokens.mutedForeground else androidx.compose.ui.graphics.Color.Unspecified,
            )
        }
    }
}
