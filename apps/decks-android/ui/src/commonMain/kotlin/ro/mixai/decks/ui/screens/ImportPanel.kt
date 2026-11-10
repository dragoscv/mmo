package ro.mixai.decks.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ro.mixai.decks.ui.components.PadButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.engine.ImportConflictUi
import ro.mixai.decks.ui.engine.ImportFailure
import ro.mixai.decks.ui.engine.ImportOptionsUi
import ro.mixai.decks.ui.engine.ImportPort
import ro.mixai.decks.ui.engine.ImportPreviewUi
import ro.mixai.decks.ui.engine.ImportReportUi
import ro.mixai.decks.ui.engine.ImportResult
import ro.mixai.decks.ui.engine.ImportSource
import ro.mixai.decks.ui.engine.ImportTarget
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksType

/** Where the import flow stands. */
enum class ImportStep { PICK, PREVIEW, RUNNING, DONE }

/**
 * State of the import screen (WP19-38): source → pick → preview (re-run when options change) →
 * import → report. Every method calls the [port] synchronously; the composable runs them off the
 * UI thread. Snapshot state may be written from any thread.
 *
 * The busy flag is the panel's concurrency guard: [guarded] claims it with an atomic
 * compare-and-set, so two taps landing on different background threads cannot both start an
 * import (WP19-40 P1-20), and it is always released in `finally` — a failure or a cancelled
 * panel never leaves the panel stuck on "Importing…".
 */
class ImportState(private val port: ImportPort?) {
    var source by mutableStateOf(ImportSource.AUTO)
    var options by mutableStateOf(ImportOptionsUi())
        private set
    var step by mutableStateOf(ImportStep.PICK)
        private set
    var target by mutableStateOf<ImportTarget?>(null)
        private set
    var preview by mutableStateOf<ImportPreviewUi?>(null)
        private set
    var report by mutableStateOf<ImportReportUi?>(null)
        private set
    var failure by mutableStateOf<ImportFailure?>(null)
        private set
    var failureReason by mutableStateOf("")
        private set
    var busy by mutableStateOf(false)
        private set

    val available: Boolean get() = port != null

    /** True when [run] would be accepted (a preview exists and the library is not locked). */
    val canRun: Boolean get() = !busy && step == ImportStep.PREVIEW && preview?.protected == false

    private fun fail(f: ImportFailure, reason: String) {
        failure = f
        failureReason = reason
    }

    /**
     * Claims the panel for one operation; false when another one already holds it. Call it on the
     * UI thread *before* launching the work: Compose dispatches click callbacks on a single
     * thread, so the check-then-set is atomic there and the second tap of a double tap is dropped.
     * Claiming inside the background block instead is the race the reviewer found (two coroutines
     * both read `busy == false` on Dispatchers.Default and both start an import).
     */
    fun begin(): Boolean {
        if (busy) return false
        busy = true
        return true
    }

    /** Releases the claim. Always from a `finally`, so a failure or a cancelled panel cannot stick. */
    fun finish() {
        busy = false
    }

    /**
     * Claim-and-run, for callers that have not claimed yet (direct calls and the tests). The
     * composable uses [begin] + the `…Claimed` methods instead, because it must claim on the UI
     * thread and run the blocking FFI work off it.
     */
    private inline fun guarded(block: () -> Unit) {
        if (!begin()) return
        try {
            block()
        } finally {
            finish()
        }
    }

    /** A file or folder was picked: resolve the format, then preview. */
    fun pick(path: String) = guarded { pickClaimed(path) }

    /** [pick] without the guard: the caller already holds the panel ([begin]). Blocking. */
    fun pickClaimed(path: String) {
        failure = null
        report = null
        preview = null
        val p = port ?: return fail(ImportFailure.UNSUPPORTED, "")
        val t = p.resolve(source, path)
        target = t
        if (t == null) {
            step = ImportStep.PICK
            return fail(ImportFailure.NOT_RECOGNISED, path)
        }
        loadPreview(p, t)
    }

    private fun loadPreview(p: ImportPort, t: ImportTarget) {
        when (val r = p.preview(t, options)) {
            is ImportResult.Ok -> {
                preview = r.value
                failure = if (r.value.protected) ImportFailure.PROTECTED else null
                step = ImportStep.PREVIEW
            }
            is ImportResult.Err -> {
                step = ImportStep.PICK
                fail(r.failure, r.reason)
            }
        }
    }

    fun setConflict(c: ImportConflictUi) {
        options = options.copy(conflict = c)
    }

    fun setDrift(on: Boolean) {
        options = options.copy(correctDrift = on)
    }

    /** Adds a relocation folder and refreshes the preview (missing / relocatable counts change). */
    fun addRelocateRoot(dir: String) = guarded { addRelocateRootClaimed(dir) }

    /** [addRelocateRoot] without the guard: the caller already holds the panel. Blocking. */
    fun addRelocateRootClaimed(dir: String) {
        if (dir.isBlank() || dir in options.relocateRoots) return
        options = options.copy(relocateRoots = options.relocateRoots + dir)
        val p = port ?: return
        target?.let { loadPreview(p, it) }
    }

    fun removeRelocateRoot(dir: String) = guarded { removeRelocateRootClaimed(dir) }

    /** [removeRelocateRoot] without the guard: the caller already holds the panel. Blocking. */
    fun removeRelocateRootClaimed(dir: String) {
        options = options.copy(relocateRoots = options.relocateRoots - dir)
        val p = port ?: return
        target?.let { loadPreview(p, it) }
    }

    /** Runs the import with the current options. */
    fun run() {
        if (!canRun) return
        guarded { runClaimed() }
    }

    /**
     * [run] without the guard: the caller already holds the panel ([begin] on the UI thread), so
     * [canRun] is re-checked here against the claim it took. Blocking (minutes for a big library).
     */
    fun runClaimed() {
        val p = port ?: return
        val t = target ?: return
        if (step != ImportStep.PREVIEW || preview?.protected != false) return
        step = ImportStep.RUNNING
        when (val r = p.run(t, options)) {
            is ImportResult.Ok -> {
                report = r.value
                failure = null
                step = ImportStep.DONE
            }
            is ImportResult.Err -> {
                step = ImportStep.PREVIEW
                fail(r.failure, r.reason)
            }
        }
    }

    fun reset() {
        step = ImportStep.PICK
        target = null
        preview = null
        report = null
        failure = null
    }
}

/**
 * Import from rekordbox / Serato / Traktor (WP19-38). [pickFile] opens the platform picker and
 * calls back with a path (also used for relocation folders); [onDone] closes the panel (the host
 * refreshes the library when a report exists).
 */
@Composable
fun ImportPanel(
    port: ImportPort?,
    pickFile: ((String) -> Unit) -> Unit,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
    state: ImportState = remember(port) { ImportState(port) },
) {
    val type = LocalDecksType.current
    // The import runs for minutes; closing the panel must not tear it down mid-write. A scope
    // owned by the panel (cancelled only when the panel leaves the composition for good) plus
    // NonCancellable around the FFI call keeps the library consistent, and `finally` always
    // releases the claim (P1-20).
    val scope = remember(state) { CoroutineScope(SupervisorJob() + decksBgDispatcher) }
    DisposableEffect(scope) { onDispose { scope.cancel() } }
    // Claimed HERE, on the UI thread, before the work is launched: two taps cannot both pass.
    fun bg(block: ImportState.() -> Unit) {
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
            BasicText(str(Str.ImportTitle), style = type.label, modifier = Modifier.semantics { heading() })
            if (!state.available) {
                BasicText(str(Str.ImportUnsupported), style = type.small.copy(color = DecksColors.muted))
                PadButton(str(Str.ImportClose), str(Str.ImportClose)) { onDone() }
                return@Column
            }

            // Source
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                BasicText(str(Str.ImportSourceLabel), style = type.small)
                for (s in ImportSource.entries) {
                    val label = when (s) {
                        ImportSource.AUTO -> str(Str.ImportAuto)
                        ImportSource.REKORDBOX -> "rekordbox"
                        ImportSource.SERATO -> "Serato"
                        ImportSource.TRAKTOR -> "Traktor"
                    }
                    PadButton(
                        label, "${str(Str.ImportSourceLabel)}: $label",
                        active = state.source == s,
                        enabled = !state.busy && state.step != ImportStep.RUNNING,
                        state = if (state.source == s) str(Str.On) else str(Str.Off),
                    ) { state.source = s }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PadButton(str(Str.ImportPick), str(Str.ImportPick), enabled = !state.busy && state.step != ImportStep.RUNNING) {
                    pickFile { path -> bg { pickClaimed(path) } }
                }
                state.target?.let { t ->
                    BasicText(
                        "${t.label} · ${t.path}", style = type.small.copy(color = DecksColors.muted),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                }
            }

            // Failure line (announced to screen readers).
            state.failure?.let { f ->
                val text = when (f) {
                    ImportFailure.PROTECTED -> str(Str.ImportProtected)
                    ImportFailure.NOT_RECOGNISED -> str(Str.ImportNotRecognised)
                    ImportFailure.UNSUPPORTED -> str(Str.ImportUnsupported)
                    ImportFailure.FAILED -> str(Str.ImportFailed, state.failureReason)
                }
                BasicText(
                    text, style = type.small.copy(color = statusText(DecksColors.danger)),
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }

            // Preview + options
            val p = state.preview
            if (p != null && state.step != ImportStep.DONE) {
                BasicText(str(Str.ImportPreviewTitle), style = type.label, modifier = Modifier.semantics { heading() })
                BasicText(str(Str.ImportTracks, p.tracksSeen, p.newTracks, p.matchedByPath, p.matchedByHash), style = type.body)
                BasicText(str(Str.ImportExtras, p.cues, p.grids, p.playlists), style = type.body)
                if (p.missingFiles > 0 || p.relocatable > 0) {
                    BasicText(
                        str(Str.ImportMissing, p.missingFiles, p.relocatable),
                        style = type.body.copy(color = if (p.missingFiles > 0) statusText(DecksColors.warning) else DecksColors.foreground),
                    )
                    p.missingSample.take(3).forEach {
                        BasicText(it, style = type.small.copy(color = DecksColors.muted), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (p.warnings.isNotEmpty()) {
                    BasicText(str(Str.ImportWarnings, p.warnings.size), style = type.small.copy(color = statusText(DecksColors.warning)))
                }

                BasicText(str(Str.ImportConflict), style = type.small)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (c in ImportConflictUi.entries) {
                        val label = when (c) {
                            ImportConflictUi.KEEP_EXISTING -> str(Str.ImportKeep)
                            ImportConflictUi.PREFER_IMPORTED -> str(Str.ImportPrefer)
                            ImportConflictUi.MERGE -> str(Str.ImportMerge)
                        }
                        PadButton(
                            label, "${str(Str.ImportConflict)}: $label",
                            active = state.options.conflict == c, enabled = !state.busy,
                            state = if (state.options.conflict == c) str(Str.On) else str(Str.Off),
                        ) { state.setConflict(c) }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PadButton(
                        str(Str.ImportDrift), str(Str.ImportDrift),
                        active = state.options.correctDrift, enabled = !state.busy,
                        state = if (state.options.correctDrift) str(Str.On) else str(Str.Off),
                    ) { state.setDrift(!state.options.correctDrift) }
                    PadButton(str(Str.ImportRelocate), str(Str.ImportRelocate), enabled = !state.busy) {
                        pickFile { dir -> bg { addRelocateRootClaimed(dir) } }
                    }
                }
                state.options.relocateRoots.forEach { dir ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        BasicText(dir, style = type.small, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        PadButton("×", "${str(Str.ImportRemoveFolder)}: $dir", enabled = !state.busy) {
                            bg { removeRelocateRootClaimed(dir) }
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PadButton(
                        if (state.step == ImportStep.RUNNING) str(Str.ImportRunning) else str(Str.ImportRun),
                        str(Str.ImportRun), active = true, enabled = state.canRun,
                    ) { bg { runClaimed() } }
                    PadButton(str(Str.ImportClose), str(Str.ImportClose), enabled = state.step != ImportStep.RUNNING) { onDone() }
                }
            }

            // Report
            state.report?.let { r ->
                Column(
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                ) {
                    BasicText(
                        str(Str.ImportDone, r.inserted, r.mergedByPath + r.mergedByHash, r.cues, r.playlists),
                        style = type.body.copy(color = statusText(DecksColors.success)),
                    )
                    if (r.relocated > 0 || r.driftFixes > 0) {
                        BasicText(str(Str.ImportReportRelocated, r.relocated, r.driftFixes), style = type.body)
                    }
                    if (r.unmatched.isNotEmpty()) {
                        BasicText(str(Str.ImportReportMissing, r.unmatched.size), style = type.body.copy(color = statusText(DecksColors.warning)))
                    }
                    if (r.warnings.isNotEmpty()) {
                        BasicText(str(Str.ImportWarnings, r.warnings.size), style = type.small.copy(color = statusText(DecksColors.warning)))
                        r.warnings.take(3).forEach {
                            BasicText(it, style = type.small.copy(color = DecksColors.muted), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                PadButton(str(Str.ImportClose), str(Str.ImportClose)) { onDone() }
            }
        }
    }
}
