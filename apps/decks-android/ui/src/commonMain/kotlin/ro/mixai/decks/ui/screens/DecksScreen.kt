package ro.mixai.decks.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.ComposeWaveforms
import ro.mixai.decks.ui.components.LocalDeckGrids
import ro.mixai.decks.ui.components.PadButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.components.WaveformSlot
import ro.mixai.decks.ui.components.WavesPanel
import ro.mixai.decks.ui.engine.DemoPacks
import ro.mixai.decks.ui.engine.GridPort
import ro.mixai.decks.ui.engine.GridStateUi
import ro.mixai.decks.ui.engine.LayoutDoc
import ro.mixai.decks.ui.engine.PackPort
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.LocalDecksSkin
import ro.mixai.decks.ui.theme.LocalDecksType
import ro.mixai.decks.ui.theme.LocalReducedMotion
import ro.mixai.decks.ui.theme.SkinState

/**
 * Result of a pack install, shown to the user (WP19-40 P1-17): until now it only reached
 * `Log.w` / stderr, so a rejected pack looked like nothing had happened even though the
 * `pack_installed` / `pack_rejected` strings existed.
 */
sealed interface PackNotice {
    data class Installed(val name: String) : PackNotice
    data class Rejected(val reason: String) : PackNotice
}

/**
 * Per-deck beatgrids for the waveform lanes (WP19-40 P1-18). The grid of a loaded track is read
 * from the [GridPort] **once per (deck, trackId)** on a background thread and cached: the
 * waveform draws every frame, and the FFI call sits behind the shared library mutex, so reading
 * it per frame would stall the UI during an import. [refresh] re-reads one deck after the grid
 * editor changed it; [put] takes the edited grid straight from the editor, with no FFI call.
 */
class DeckGridCache(private val port: GridPort?, private val decks: Int) {
    /** Index = deck; null = no stored grid (the waveform falls back to the deck's constant tempo). */
    var grids by mutableStateOf<List<GridStateUi?>>(List(decks) { null })
        private set

    private val loaded = arrayOfNulls<String>(decks)

    /** True when deck [i] still needs a read for [trackId] (null trackId = the deck is empty). */
    fun needs(i: Int, trackId: String?): Boolean = i in 0 until decks && loaded[i] != (trackId ?: "")

    /** Blocking (FFI behind the library mutex): call off the UI thread. */
    fun load(i: Int, trackId: String?) {
        if (i !in 0 until decks) return
        loaded[i] = trackId ?: ""
        val g = if (trackId.isNullOrEmpty()) null else runCatching { port?.grid(trackId) }.getOrNull()
        set(i, g)
    }

    /** Stores an already-known grid (the editor just applied it): no FFI call, no stale frame. */
    fun put(i: Int, grid: GridStateUi) {
        if (i !in 0 until decks) return
        loaded[i] = grid.trackId
        set(i, grid)
    }

    private fun set(i: Int, g: GridStateUi?) {
        grids = grids.toMutableList().also { it[i] = g }
    }
}

/** Padding around the screen and the gap between its rows (dp). */
const val SCREEN_PAD_DP = 8

/** A layout without its own gap takes the look's panel gap (Signature 2 dp, classic 12 dp), as Workspace.tsx does. */
fun LayoutDoc.withLookGap(skin: DecksSkin): LayoutDoc = if (gap == null) copy(gap = skin.panelGapDp) else this

/** Height (dp) of the status bar: one row of 44 dp buttons inside a panel. */
fun statusBarDp(skin: DecksSkin): Double = 2.0 * skin.panelPadDp + maxOf(44, skin.controlHeightDp)

/**
 * Height (dp) of the fixed waveform strip above the panels in a [widthDp] × [heightDp] window;
 * performance-style layouts (no library area) get the tall one.
 */
fun waveStripDp(widthDp: Float, heightDp: Float, hasLibrary: Boolean): Int = when {
    widthDp < 1000f || heightDp < 700f -> 90
    !hasLibrary -> 220
    else -> 130
}

/**
 * Size (dp) the layout host gets in a [w] × [h] window with no extra panel open: the window minus
 * the screen padding, the status bar and — for layouts without a `waves` area — the waveform strip.
 * (A layout whose `waves` panel got docked also shows the strip; that case is not modelled here.)
 */
fun layoutHostSize(w: Double, h: Double, skin: DecksSkin, layout: LayoutDoc): Pair<Double, Double> {
    var hh = h - 2 * SCREEN_PAD_DP - statusBarDp(skin) - SCREEN_PAD_DP
    if (layout.areas.none { it.panel == PanelId.Waves }) {
        hh -= waveStripDp(w.toFloat(), h.toFloat(), layout.areas.any { it.panel == PanelId.Library }) + SCREEN_PAD_DP
    }
    return (w - 2 * SCREEN_PAD_DP).coerceAtLeast(0.0) to hh.coerceAtLeast(0.0)
}

private val WavesShownInStrip: Set<PanelId> = setOf(PanelId.Waves)
private val NothingShownElsewhere: Set<PanelId> = emptySet()

/**
 * Root of the Decks UI (shared by Android and Desktop).
 * Zero-scroll (WP19-34): status bar + waveform strip, then a [LayoutHost] that places every panel
 * by the solver (the skin's layout: a built-in preset or an installed pack layout; phones under
 * [PHONE_MAX_WIDTH_DP] get the native phone layout). Panels that do not fit, or that this app does
 * not have, go to the dock. Nothing scrolls. [onLayoutSolved] reports the layout in use and every
 * new solver result (tests, diagnostics).
 */
@Composable
fun DecksScreen(
    ctl: DecksController,
    waveforms: WaveformSlot = { f, p, m -> ComposeWaveforms(f, p, m) },
    onScanFolder: (() -> Unit)? = null,
    autoFocus: Boolean = true,
    skins: SkinState? = null,
    recordPath: (() -> String)? = null,
    onExport: (String, String) -> Unit = { _, _ -> },
    onImportPack: (() -> Unit)? = null,
    packNotice: PackNotice? = null,
    onDismissPackNotice: () -> Unit = {},
    pickFile: (((String) -> Unit) -> Unit)? = null,
    onLayoutSolved: ((LayoutDoc, ro.mixai.decks.ui.engine.LayoutSolution) -> Unit)? = null,
) {
    val reduced = LocalReducedMotion.current
    val skin = LocalDecksSkin.current
    val port: PackPort? = remember(ctl) { ctl.backend.packs() }
    val gridPort = remember(ctl) { ctl.backend.grids() }
    val importPort = remember(ctl) { ctl.backend.importer() }
    val safetyPort = remember(ctl) { ctl.backend.librarySafety() }
    val revision = skins?.packRevision ?: 0
    val layouts = remember(port, revision) { runCatching { port?.layouts() }.getOrNull() ?: DemoPacks.presets }
    val chosen = skin.resolveLayout(layouts) ?: DemoPacks.presets.first()
    LaunchedEffect(ctl) {
        ctl.startEngine()
        while (true) withFrameNanos { ctl.tick() }
    }
    val focus = remember { FocusRequester() }
    if (autoFocus) {
        LaunchedEffect(Unit) { delay(50); runCatching { focus.requestFocus() } }
    }
    var zoom by remember { mutableStateOf(8f) }
    var showConnect by remember { mutableStateOf(false) }
    var showAi by remember { mutableStateOf(false) }
    var showSet by remember { mutableStateOf(false) }
    var showGrid by remember { mutableStateOf(false) }
    var showImport by remember { mutableStateOf(false) }
    var showSafety by remember { mutableStateOf(false) }
    // Beatgrids for the waveform lanes: read off the UI thread, once per loaded track (P1-18).
    val gridCache = remember(gridPort) { DeckGridCache(gridPort, ctl.controls.size.coerceAtLeast(1)) }
    val deckTrackIds = ctl.controls.indices.map { ctl.deckRow(it)?.id }
    LaunchedEffect(gridCache, deckTrackIds) {
        withContext(decksBgDispatcher) {
            deckTrackIds.forEachIndexed { i, id -> if (gridCache.needs(i, id)) gridCache.load(i, id) }
        }
    }
    // Read once per panel toggle: the lock changes only from the safety panel.
    val safetyProtected = remember(safetyPort, showSafety) {
        runCatching { safetyPort?.isProtected() }.getOrNull() == true
    }

    BoxWithConstraints(
        Modifier.fillMaxSize()
            .background(DecksColors.background)
            .onKeyEvent {
                if (skins != null && it.type == KeyEventType.KeyDown && it.isCtrlPressed && it.key == Key.K) {
                    skins.cycle(); true
                } else handleShortcut(ctl, it) { z -> zoom = (zoom * z).coerceIn(2f, 32f) }
            }
            .focusRequester(focus)
            .focusable(),
    ) {
        // One LayoutDoc instance per (layout, gap): a new copy every frame would defeat the skipping of
        // LayoutHost and every panel under it (this scope recomposes each frame for the waveform).
        val winW = maxWidth.value
        val winH = maxHeight.value
        val base = effectiveLayout(chosen, winW)
        val gap = skin.panelGapDp
        val layout = remember(base, gap) { if (base.gap == null) base.copy(gap = gap) else base }
        val peaks = ctl.controls.map { it.peaks }
        val frame = ctl.waveFrame(zoom, reduced)
        Column(Modifier.fillMaxSize().padding(SCREEN_PAD_DP.dp), verticalArrangement = Arrangement.spacedBy(SCREEN_PAD_DP.dp)) {
            StatusBar(
                ctl, skins, if (recordPath != null) ({ showSet = !showSet }) else null, { showAi = !showAi },
                layoutLabel = layoutName(chosen),
                onLayout = skins?.let { s -> { s.select(s.skin.copy(layoutId = nextLayout(layouts, chosen.id))) } },
                onImportPack = onImportPack,
                onGrid = if (gridPort != null) ({ showGrid = !showGrid }) else null,
                onImport = if (importPort != null && pickFile != null) ({ showImport = !showImport }) else null,
                onSafety = if (safetyPort != null) ({ showSafety = !showSafety }) else null,
                protectedLibrary = safetyProtected,
            ) { showConnect = !showConnect }
            // Pack install result: visible, dismissable, announced (P1-17).
            packNotice?.let { n ->
                val (text, role) = when (n) {
                    is PackNotice.Installed -> str(Str.PackInstalled, n.name) to DecksColors.success
                    is PackNotice.Rejected -> str(Str.PackRejected, n.reason) to DecksColors.danger
                }
                Row(
                    Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    BasicText(
                        text, style = LocalDecksType.current.body.copy(color = statusText(role)),
                        maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    PadButton("×", str(Str.ImportClose), onClick = onDismissPackNotice)
                }
            }
            if (showConnect) ConnectPanel(ctl, Modifier.fillMaxWidth())
            if (showAi) AiPanel(ctl, Modifier.fillMaxWidth())
            if (showSet && recordPath != null) SetPanel(ctl, recordPath, onExport, Modifier.fillMaxWidth())
            if (showGrid) {
                val live = ctl.liveDeck()
                val row = ctl.deckRow(live)
                val meta = ctl.controls.getOrNull(live)?.meta
                GridEditor(
                    gridPort, live, row?.id ?: "", ctl.deck(live)?.playheadSec ?: 0.0,
                    Modifier.fillMaxWidth(),
                    fallbackBpm = meta?.bpm ?: ctl.deck(live)?.bpm ?: 120.0,
                    fallbackFirstBeatSec = meta?.firstBeatSec ?: 0.0,
                    // The waveform shows the edit immediately, without another FFI read.
                    onGridChanged = { g -> gridCache.put(live, g) },
                    onClose = { showGrid = false },
                )
            }
            if (showImport && pickFile != null) {
                ImportPanel(importPort, pickFile, { showImport = false; ctl.search(ctl.query) }, Modifier.fillMaxWidth())
            }
            if (showSafety) {
                SafetyPanel(safetyPort, { ctl.search(ctl.query) }, Modifier.fillMaxWidth())
            }
            val waveLabel = str(Str.Waveform)
            // Performance-style layouts (no library area) get the tall waveform strip.
            val hasLibrary = layout.areas.any { it.panel == PanelId.Library }
            val waveH = waveStripDp(winW, winH, hasLibrary).dp
            // The scrolling waveforms of every deck: one lane per deck, centre playhead, beatgrid, cues, loop
            // (GPU renderer on device, Compose painter otherwise). The grids reach every renderer through
            // the local (P1-18). The lambda is one stable instance that reads the per-frame frame / peaks
            // through state, so only the lanes redraw each frame, not the layout host that carries them.
            val frameNow = rememberUpdatedState(frame)
            val peaksNow = rememberUpdatedState(peaks)
            val slot = rememberUpdatedState(waveforms)
            val lanes: @Composable (Modifier) -> Unit = remember(gridCache, waveLabel) {
                { m ->
                    CompositionLocalProvider(LocalDeckGrids provides gridCache.grids) {
                        slot.value(frameNow.value, peaksNow.value, m.semantics { contentDescription = waveLabel })
                    }
                }
            }
            // Decks 1.5: layouts with a `waves` area (Pro, Vertical waves) place the band as a panel; the fixed
            // strip above the panels stays for layouts without one (the 1.x layouts, phones) and for windows
            // where the solver could not place that panel and docked it (Vertical waves under ~1120 dp): a
            // DJ screen always shows a scrolling waveform. The strip then replaces the panel's dock tab.
            val hasWaves = layout.areas.any { it.panel == PanelId.Waves }
            var wavesDocked by remember(layout) { mutableStateOf(false) }
            val strip = !hasWaves || wavesDocked
            if (strip) {
                Box(Modifier.fillMaxWidth().height(waveH)) { lanes(Modifier.fillMaxSize()) }
            }
            val hasCrossfader = layout.areas.any { it.panel == PanelId.Crossfader }
            val report = rememberUpdatedState(onLayoutSolved)
            val onSolved: (ro.mixai.decks.ui.engine.LayoutSolution) -> Unit = remember(layout) {
                { sol ->
                    wavesDocked = PanelId.Waves in sol.docked
                    report.value?.invoke(layout, sol)
                }
            }
            LayoutHost(
                layout, port, Modifier.fillMaxWidth().weight(1f),
                shownElsewhere = if (strip && hasWaves) WavesShownInStrip else NothingShownElsewhere,
                onSolved = onSolved,
            ) { id, tier, m ->
                when (id) {
                    PanelId.DeckA -> DeckPanel(ctl, 0, m, tier)
                    PanelId.DeckB -> DeckPanel(ctl, 1, m, tier)
                    PanelId.Mixer -> MixerPanel(ctl, m, tier, withCrossfader = !hasCrossfader)
                    PanelId.Crossfader -> CrossfaderPanel(ctl, m, tier)
                    PanelId.Library -> LibraryPanel(ctl, onScanFolder, m, tier)
                    PanelId.Waves -> WavesPanel(m, lanes)
                    else -> Unavailable(id, m)
                }
            }
        }
    }
}

private fun nextLayout(all: List<ro.mixai.decks.ui.engine.LayoutDoc>, current: String): String {
    if (all.isEmpty()) return DecksSkin.DEFAULT_LAYOUT
    val i = all.indexOfFirst { it.id == current }
    return all[(i + 1).mod(all.size)].id
}

@Composable
private fun StatusBar(
    ctl: DecksController,
    skins: SkinState?,
    onSet: (() -> Unit)?,
    onAi: () -> Unit,
    layoutLabel: String,
    onLayout: (() -> Unit)?,
    onImportPack: (() -> Unit)?,
    onGrid: (() -> Unit)?,
    onImport: (() -> Unit)?,
    onSafety: (() -> Unit)?,
    protectedLibrary: Boolean,
    onConnect: () -> Unit,
) {
    val type = LocalDecksType.current
    val clock = ctl.engine.clock
    Panel(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            BasicText(str(Str.AppName), style = type.title.copy(color = DecksColors.primary))
            val src = clock.sourceDeck?.let { str(if (it == 0) Str.DeckA else Str.DeckB) } ?: str(Str.InternalClock)
            val beat = if (clock.bpm > 0) (kotlin.math.floor(clock.beat).toLong() % clock.beatsPerBar.coerceAtLeast(1) + 1) else 0
            BasicText(
                "${str(Str.MasterClock)}: ${Format.bpm(clock.bpm.takeIf { it > 0 })} · $src · $beat/${clock.beatsPerBar}",
                style = type.body.copy(color = clock.sourceDeck?.let { DecksColors.deck(it) } ?: DecksColors.foreground),
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
            BasicText(
                if (ctl.backend.isNative) ctl.backend.description else str(Str.DemoEngine),
                // Amber text is below 4.5:1 on light panels: `statusText` keeps the role only
                // while it passes AA and falls back to the foreground role otherwise.
                style = type.small.copy(
                    color = if (ctl.backend.isNative) DecksColors.muted else statusText(DecksColors.warning),
                ),
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            ctl.startError?.let {
                BasicText(str(Str.EngineError, it), style = type.small.copy(color = DecksColors.danger), maxLines = 1,
                    overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            }
            Box(Modifier.weight(1f))
            BasicText(
                "${str(Str.Midi)}: ${ctl.midiStatus ?: str(Str.MidiNone)}" + (ctl.lastMidi?.let { " · $it" } ?: ""),
                style = type.small.copy(color = DecksColors.muted), maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            ConnectChip(ctl, onConnect)
            PadButton(str(Str.AiTitle), str(Str.AiTitle), active = ctl.mixProgress != null, onClick = onAi)
            if (onSet != null) {
                PadButton(
                    if (ctl.recordingOn) "● ${Format.time(ctl.recordElapsed).substringBefore('.')}" else str(Str.SetRecord),
                    str(Str.SetTitle), active = ctl.recordingOn, accent = DecksColors.danger, onClick = onSet,
                )
            }
            if (skins != null) {
                val name = skinName(skins.skin)
                PadButton(str(Str.Skin, name), "${str(Str.SkinNext)} · ${str(Str.Skin, name)}") { skins.cycle() }
            }
            if (onLayout != null) {
                PadButton(str(Str.Layout, layoutLabel), "${str(Str.LayoutNext)} · ${str(Str.Layout, layoutLabel)}", onClick = onLayout)
            }
            if (onImportPack != null) PadButton(str(Str.PackImport), str(Str.PackImport), onClick = onImportPack)
            if (onGrid != null) PadButton(str(Str.GridTitle), str(Str.GridTitle), onClick = onGrid)
            if (onImport != null) PadButton(str(Str.ImportTitle), str(Str.ImportTitle), onClick = onImport)
            if (onSafety != null) {
                PadButton(str(Str.SafetyTitle), str(Str.SafetyTitle), active = protectedLibrary, onClick = onSafety)
                ProtectBadge(protectedLibrary)
            }
        }
    }
}

@Composable
fun skinName(s: DecksSkin): String = when (s.id) {
    "signature" -> str(Str.SkinSignature)
    "glass-classic", "nocturne" -> str(Str.SkinGlassClassic)
    "mainroom" -> str(Str.SkinMainroom)
    "crate" -> str(Str.SkinCrate)
    "pilot" -> str(Str.SkinPilot)
    "club" -> str(Str.SkinClub)
    "booth" -> str(Str.SkinBooth)
    "studio" -> str(Str.SkinStudio)
    "emerald" -> str(Str.SkinEmerald)
    else -> s.id
}

/**
 * Global keyboard map (desktop + Android hardware keyboards / ChromeOS). Runs in the bubbling
 * phase: a focused button / knob / the search field consumes its own keys first, so Space on a
 * focused button activates that button and typing in the search field never fires shortcuts.
 */
private fun handleShortcut(ctl: DecksController, e: KeyEvent, zoom: (Float) -> Unit): Boolean {
    if (e.type != KeyEventType.KeyDown) {
        if (e.type == KeyEventType.KeyUp && (e.key == Key.Q || e.key == Key.W)) {
            ctl.cue(if (e.key == Key.Q) 0 else 1, false); return true
        }
        return false
    }
    when (e.key) {
        Key.Spacebar -> if (!e.isCtrlPressed) ctl.togglePlay(0) else return false
        Key.Enter, Key.NumPadEnter -> if (e.isCtrlPressed) ctl.togglePlay(1) else return false
        Key.P -> ctl.togglePlay(1)
        Key.Q -> ctl.cue(0, true)
        Key.W -> ctl.cue(1, true)
        Key.One, Key.Two, Key.Three, Key.Four -> ctl.hotCue(0, e.key.digit())
        Key.Seven, Key.Eight, Key.Nine, Key.Zero -> ctl.hotCue(1, e.key.digit() - 6)
        Key.S -> ctl.syncTap(0)
        Key.K -> ctl.syncTap(1)
        Key.L -> ctl.loopAuto(0)
        Key.O -> ctl.loopAuto(1)
        Key.DirectionUp -> ctl.moveSelection(-1)
        Key.DirectionDown -> ctl.moveSelection(1)
        Key.DirectionLeft -> if (e.isCtrlPressed) ctl.loadSelected(0) else return false
        Key.DirectionRight -> if (e.isCtrlPressed) ctl.loadSelected(1) else return false
        Key.Plus, Key.Equals -> zoom(0.8f)
        Key.Minus -> zoom(1.25f)
        else -> return false
    }
    return true
}

private fun Key.digit(): Int = when (this) {
    Key.One -> 0; Key.Two -> 1; Key.Three -> 2; Key.Four -> 3
    Key.Seven -> 6; Key.Eight -> 7; Key.Nine -> 8; Key.Zero -> 9
    else -> 0
}
