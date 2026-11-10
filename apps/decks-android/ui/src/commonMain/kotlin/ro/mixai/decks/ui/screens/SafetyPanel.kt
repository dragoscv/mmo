package ro.mixai.decks.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ro.mixai.decks.ui.components.PadButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.engine.SafetyLogic
import ro.mixai.decks.ui.engine.SafetyPort
import ro.mixai.decks.ui.engine.SafetyResult
import ro.mixai.decks.ui.engine.SnapshotUi
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksType
import ro.mixai.decks.ui.theme.Oklab

/** Last message of the panel. */
sealed interface SafetyNotice {
    data object Restored : SafetyNotice
    data class Failed(val reason: String) : SafetyNotice
}

/**
 * State of [SafetyPanel] (WP19-40). Plain class so tests drive it without Compose; every port call
 * is synchronous here and the panel runs it off the UI thread.
 */
class SafetyState(private val port: SafetyPort?) {
    var protected by mutableStateOf(false)
        private set
    var snapshots by mutableStateOf<List<SnapshotUi>>(emptyList())
        private set
    /** Snapshot awaiting the confirm step of a restore. */
    var confirming by mutableStateOf<SnapshotUi?>(null)
        private set
    var notice by mutableStateOf<SafetyNotice?>(null)
        private set
    var busy by mutableStateOf(false)
        private set

    /**
     * Claims the panel for one action. Compose event callbacks run on the UI thread, so this
     * check-then-set is atomic there and a double tap cannot start two snapshots / restores.
     * Always pair with [finish] in a `finally` — one failure must not leave the panel busy
     * forever (WP19-40 P1-16).
     */
    fun begin(): Boolean {
        if (busy) return false
        busy = true
        return true
    }

    fun finish() {
        busy = false
    }

    val available: Boolean get() = port != null
    val canSnapshot: Boolean get() = port?.canSnapshot == true

    fun refresh() {
        val p = port ?: return
        protected = p.isProtected()
        snapshots = p.snapshots()
    }

    fun toggleProtected() {
        val p = port ?: return
        handle(p.setProtected(!protected)) { }
        protected = p.isProtected()
    }

    fun snapshotNow() {
        val p = port ?: return
        handle(p.snapshotNow("manual")) { notice = null }
        snapshots = p.snapshots()
    }

    fun askRestore(s: SnapshotUi) {
        confirming = s
        notice = null
    }

    fun cancelRestore() {
        confirming = null
    }

    /** Confirmed restore; returns true when the library was replaced (caller reloads its views). */
    fun confirmRestore(): Boolean {
        val p = port ?: return false
        val s = confirming ?: return false
        confirming = null
        var ok = false
        handle(p.restore(s.id)) {
            ok = true
            notice = SafetyNotice.Restored
        }
        refresh()
        return ok
    }

    fun dismissNotice() {
        notice = null
    }

    private inline fun <T> handle(r: SafetyResult<T>, onOk: (T) -> Unit) {
        when (r) {
            is SafetyResult.Ok -> onOk(r.value)
            is SafetyResult.Failed -> notice = SafetyNotice.Failed(r.reason)
        }
    }
}

/** Remembers a [SafetyState] for [port] and loads it once. */
@Composable
fun rememberSafetyState(port: SafetyPort?): SafetyState {
    val state = remember(port) { SafetyState(port) }
    LaunchedEffect(state) { withContext(decksBgDispatcher + NonCancellable) { state.refresh() } }
    return state
}

/**
 * Where every blocking engine call of the Decks panels runs (WP19-40 P1-17). The library FFI is a
 * blocking JNA call behind a shared mutex — an import holds it for minutes — so it belongs on the
 * IO dispatcher, never on Main / the EDT.
 */
internal val decksBgDispatcher get() = Dispatchers.IO

/**
 * Text colour for a status role (warning / success / danger) on a panel (WP19-40 P1-20). Amber and
 * green are ~2:1 against a light panel, so using them as a TEXT colour fails WCAG 2.2 AA on the
 * light skins: keep the role only while it reaches 4.5:1 over the composited panel surface, else
 * fall back to the foreground role (the meaning stays in the words, not the colour alone). Same
 * rule as the engine chip in [DecksScreen]. `SafetyTest.statusTextMeetsAaOnEveryPreset` asserts it.
 */
@Composable
fun statusText(role: Color): Color = decksStatusText(role)

/** Non-composable form, so tests can assert the rule for every preset. */
fun decksStatusText(role: Color): Color {
    val bg = DecksColors.background
    val s = DecksColors.surface
    val panel = Color(
        s.red * s.alpha + bg.red * (1 - s.alpha),
        s.green * s.alpha + bg.green * (1 - s.alpha),
        s.blue * s.alpha + bg.blue * (1 - s.alpha),
        1f,
    )
    return if (Oklab.contrast(role, panel) >= 4.5) role else DecksColors.foreground
}

@Composable
private fun reasonLabel(reason: String): String = when (SafetyLogic.reasonKind(reason)) {
    "auto" -> str(Str.SafetyReasonAuto)
    "manual" -> str(Str.SafetyReasonManual)
    "import" -> str(Str.SafetyReasonImport)
    "schema" -> str(Str.SafetyReasonSchema)
    "pre_restore" -> str(Str.SafetyReasonPreRestore)
    else -> reason
}

/**
 * Library safety (WP19-40): protect toggle, snapshot list (date · reason · counts), "Snapshot now",
 * and Restore with a confirm step. [onRestored] runs after a successful restore so the caller
 * reloads the library views. `null` [port] = demo engine without a library (shows a hint).
 */
@Composable
fun SafetyPanel(port: SafetyPort?, onRestored: () -> Unit, modifier: Modifier = Modifier) {
    val type = LocalDecksType.current
    val state = rememberSafetyState(port)
    val scope = rememberCoroutineScope()
    // Claimed on the UI thread (atomic there), run off it, released in `finally`: one failure must
    // not leave the panel busy forever, and closing it mid-action must not either (P1-16).
    fun runAction(block: SafetyState.() -> Unit) {
        if (!state.begin()) return
        scope.launch {
            try {
                withContext(decksBgDispatcher + NonCancellable) { state.block() }
            } finally {
                state.finish()
            }
        }
    }
    Panel(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BasicText(str(Str.SafetyTitle), style = type.label, modifier = Modifier.semantics { heading() })
                if (state.protected) ProtectBadge(true)
            }
            if (!state.available) {
                BasicText(str(Str.SafetyUnavailable), style = type.small.copy(color = DecksColors.muted))
                return@Column
            }
            val protectLabel = str(Str.SafetyProtect)
            PadButton(
                protectLabel, protectLabel,
                active = state.protected, accent = DecksColors.warning, enabled = !state.busy,
                state = if (state.protected) str(Str.SafetyProtected) else null,
            ) { runAction { toggleProtected() } }
            BasicText(str(Str.SafetyProtectHint), style = type.small.copy(color = DecksColors.muted))

            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BasicText(str(Str.SafetySnapshots), style = type.label, modifier = Modifier.weight(1f).semantics { heading() })
                if (state.canSnapshot) {
                    PadButton(str(Str.SafetySnapshotNow), str(Str.SafetySnapshotNow), enabled = !state.busy) {
                        runAction { snapshotNow() }
                    }
                }
            }
            if (!state.canSnapshot) {
                BasicText(str(Str.SafetyUnavailable), style = type.small.copy(color = DecksColors.muted))
            } else if (state.snapshots.isEmpty()) {
                BasicText(str(Str.SafetyNone), style = type.small.copy(color = DecksColors.muted))
            }
            state.confirming?.let { s ->
                ConfirmRestore(
                    when_ = SafetyLogic.dateUtc(s.createdAtMs),
                    busy = state.busy,
                    onYes = {
                        runAction {
                            if (confirmRestore()) scope.launch { onRestored() }
                        }
                    },
                    onNo = { state.cancelRestore() },
                )
            }
            state.notice?.let { n ->
                val (text, colour) = when (n) {
                    SafetyNotice.Restored -> str(Str.SafetyRestored) to statusText(DecksColors.success)
                    is SafetyNotice.Failed -> str(Str.SafetyFailed, n.reason) to statusText(DecksColors.danger)
                }
                BasicText(
                    text, style = type.small.copy(color = colour),
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 320.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(state.snapshots, key = { it.id }) { s ->
                    SnapshotRow(s, enabled = !state.busy && state.confirming == null) { state.askRestore(s) }
                }
            }
        }
    }
}

@Composable
private fun SnapshotRow(s: SnapshotUi, enabled: Boolean, onRestore: () -> Unit) {
    val type = LocalDecksType.current
    val date = SafetyLogic.dateUtc(s.createdAtMs)
    val reason = reasonLabel(s.reason)
    val counts = str(Str.SafetyCounts, s.tracks, s.crates, s.cues)
    Row(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            BasicText("$date UTC · $reason", style = type.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
            BasicText(counts, style = type.small.copy(color = DecksColors.muted), maxLines = 1)
        }
        val restore = str(Str.SafetyRestore)
        PadButton(restore, "$restore: $date, $reason", enabled = enabled) { onRestore() }
    }
}

@Composable
private fun ConfirmRestore(when_: String, busy: Boolean, onYes: () -> Unit, onNo: () -> Unit) {
    val type = LocalDecksType.current
    Column(
        Modifier.fillMaxWidth()
            .background(DecksColors.surfaceRaised, RoundedCornerShape(8.dp))
            .border(1.dp, DecksColors.warning, RoundedCornerShape(8.dp))
            .padding(8.dp)
            .semantics { liveRegion = LiveRegionMode.Assertive },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        BasicText(str(Str.SafetyRestoreConfirm, "$when_ UTC"), style = type.body)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val yes = str(Str.SafetyRestoreYes)
            val no = str(Str.SafetyCancel)
            PadButton(yes, yes, active = true, accent = DecksColors.danger, enabled = !busy) { onYes() }
            PadButton(no, no, enabled = !busy) { onNo() }
        }
    }
}

/** Small "Protected" pill for the library header; renders nothing when [protected] is false. */
@Composable
fun ProtectBadge(protected: Boolean, modifier: Modifier = Modifier) {
    if (!protected) return
    val type = LocalDecksType.current
    val label = str(Str.SafetyProtected)
    Box(
        modifier
            .background(DecksColors.warning.copy(alpha = 0.18f), RoundedCornerShape(50))
            .border(1.dp, DecksColors.warning, RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .semantics { contentDescription = label },
    ) {
        BasicText(label, style = type.small.copy(color = DecksColors.foreground))
    }
}
