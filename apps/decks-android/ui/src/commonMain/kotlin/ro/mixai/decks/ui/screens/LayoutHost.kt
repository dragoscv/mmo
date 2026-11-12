package ro.mixai.decks.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import ro.mixai.decks.ui.components.PadButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.engine.DemoPacks
import ro.mixai.decks.ui.engine.LayoutDoc
import ro.mixai.decks.ui.engine.LayoutSolution
import ro.mixai.decks.ui.engine.PackPort
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelPlacement
import ro.mixai.decks.ui.engine.PanelRect
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.theme.LocalDecksType

/** Panels this app renders (two decks + the waveform band; no clock / automix / sampler / plugins yet: they go to the dock). */
val NativePanels: Set<PanelId> =
    setOf(PanelId.DeckA, PanelId.DeckB, PanelId.Mixer, PanelId.Crossfader, PanelId.Library, PanelId.Waves)

/**
 * Tier of panel [id] in a [w] × [h] dp box by the solver's own rule (`PANEL_SPECS` minimums with the
 * solver's fit tolerance); the icon tier when even that does not fit. The panels are sized for those
 * minimums (Decks 1.5: deck 480×250 / 340×190 / 220×110, mixer 240×250 / 200×190 / 150×110, crossfader
 * 220×84 / 180×40 / 140×28, library 520×240 / 320×160 / 200×96; rendered at exactly those boxes by
 * desktopTest/ContentMinimumsTest), so a placed panel is drawn at the tier the solver gave it. This
 * is only for a box the solver did not size: the dock slot under its tab strip.
 */
fun tierFor(id: PanelId, w: Double, h: Double): PanelTier =
    DemoPacks.pickTier(PanelRect(0.0, 0.0, w, h), DemoPacks.specs.getValue(id)) ?: PanelTier.Icon

/** Width (dp) under which the native phone layout ([DemoPacks.phone]) replaces the chosen one. */
const val PHONE_MAX_WIDTH_DP = 700

/** The layout to solve for a window [widthDp] wide: phones get [DemoPacks.phone]. */
fun effectiveLayout(chosen: LayoutDoc, widthDp: Float): LayoutDoc = if (widthDp < PHONE_MAX_WIDTH_DP) DemoPacks.phone else chosen

/** Height (dp) of the dock's tab strip, taken from the dock slot. */
const val DOCK_TABS_DP = 48.0

/**
 * What [LayoutHost] draws for a solver result: [panels] at the solver's tier and, when something
 * is docked, the [dock] slot with its [tabs] ([host] = the placed panel that shares the slot, shown
 * as the first tab).
 */
data class LayoutRender(
    val panels: List<PanelPlacement>,
    val dock: PanelRect?,
    val host: PanelPlacement?,
    val tabs: List<PanelId>,
) {
    /** Tier a dock tab renders at: the solver's rule for the slot minus the tab strip. */
    fun dockTier(id: PanelId): PanelTier {
        val d = dock ?: return PanelTier.Icon
        return tierFor(id, d.w, (d.h - DOCK_TABS_DP).coerceAtLeast(0.0))
    }

    /** Tier panel [id] is drawn at without the user touching the dock; null = behind a dock tab or not in the layout. */
    fun tier(id: PanelId): PanelTier? =
        panels.firstOrNull { it.panel == id }?.tier ?: if (host?.panel == id) dockTier(id) else null
}

/**
 * The drawing plan for [sol]. Docked panels in [shownElsewhere] get no tab (the caller shows them
 * itself, e.g. the waveform strip); when nothing else is docked there is no dock at all.
 */
fun layoutRender(sol: LayoutSolution, shownElsewhere: Set<PanelId> = emptySet()): LayoutRender {
    val docked = sol.docked.filter { it !in shownElsewhere }
    val dock = sol.dock.takeIf { docked.isNotEmpty() }
    // The panel the dock shares its slot with (it becomes the first tab).
    val host = dock?.let { d -> sol.placements.firstOrNull { it.rect == d } }
    return LayoutRender(sol.placements.filter { it !== host }, dock, host, if (dock == null) emptyList() else listOfNotNull(host?.panel) + docked)
}

/**
 * Zero-scroll layout host (WP19-34, docs/decks/layouts.md "Native apps"): measures the available
 * box, asks the solver (decks-ffi, or [DemoPacks] without the native library) for rects + tiers,
 * places every panel absolutely and puts what does not fit — or what this app does not render —
 * in a tabbed dock at the solver's dock rect. Nothing here scrolls. [onSolved] gets every new
 * solver result (after the composition that used it); [shownElsewhere] = docked panels the caller
 * shows itself (no dock tab).
 */
@Composable
fun LayoutHost(
    layout: LayoutDoc,
    port: PackPort?,
    modifier: Modifier = Modifier,
    available: Set<PanelId> = NativePanels,
    shownElsewhere: Set<PanelId> = emptySet(),
    onSolved: ((LayoutSolution) -> Unit)? = null,
    panel: @Composable (id: PanelId, tier: PanelTier, modifier: Modifier) -> Unit,
) {
    val solved by rememberUpdatedState(onSolved)
    BoxWithConstraints(modifier.fillMaxSize()) {
        val w = maxWidth.value.toDouble()
        val h = maxHeight.value.toDouble()
        val solver = port ?: DemoPacks
        val sol = remember(layout, w, h, available, solver) { solver.solve(layout, w, h, available) }
        val plan = remember(sol, shownElsewhere) { layoutRender(sol, shownElsewhere) }
        // Once per solver result (the holder is not state: writing it must not recompose anything).
        val reported = remember { arrayOfNulls<LayoutSolution>(1) }
        SideEffect {
            if (reported[0] !== sol) {
                reported[0] = sol
                solved?.invoke(sol)
            }
        }
        Placed(plan, panel)
    }
}

@Composable
private fun Placed(plan: LayoutRender, panel: @Composable (PanelId, PanelTier, Modifier) -> Unit) {
    for (p in plan.panels) {
        val r = p.rect
        Box(Modifier.offset(r.x.dp, r.y.dp).size(r.w.dp, r.h.dp).semantics { testTag = "panel-${p.panel.key}" }) {
            panel(p.panel, p.tier, Modifier.fillMaxSize())
        }
    }
    val dock = plan.dock
    if (dock != null) {
        Box(Modifier.offset(dock.x.dp, dock.y.dp).size(dock.w.dp, dock.h.dp).semantics { testTag = "dock" }) {
            Dock(plan, panel)
        }
    }
}

@Composable
private fun Dock(plan: LayoutRender, panel: @Composable (PanelId, PanelTier, Modifier) -> Unit) {
    val tabs = plan.tabs
    var selected by remember(tabs) { mutableStateOf(tabs.first()) }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (t in tabs) {
                val name = panelName(t)
                PadButton(name, str(Str.DockTab, name), active = t == selected, state = str(if (t == selected) Str.On else Str.Off)) {
                    selected = t
                }
            }
        }
        Box(Modifier.fillMaxWidth().weight(1f)) {
            if (selected in NativePanels) panel(selected, plan.dockTier(selected), Modifier.fillMaxSize())
            else Unavailable(selected, Modifier.fillMaxSize())
        }
    }
}

/** Placeholder for a panel of the layout format this app does not have yet. */
@Composable
fun Unavailable(id: PanelId, modifier: Modifier = Modifier) {
    Panel(modifier) {
        BasicText(str(Str.PanelUnavailable, panelName(id)), style = LocalDecksType.current.small)
    }
}

@Composable
fun panelName(id: PanelId): String = when (id) {
    PanelId.DeckA -> str(Str.DeckA)
    PanelId.DeckB -> str(Str.DeckB)
    PanelId.DeckC -> str(Str.DeckC)
    PanelId.DeckD -> str(Str.DeckD)
    PanelId.Clock -> str(Str.PanelClock)
    PanelId.Mixer -> str(Str.Mixer)
    PanelId.Crossfader -> str(Str.Crossfader)
    PanelId.Library -> str(Str.Library)
    PanelId.Automix -> str(Str.PanelAutomix)
    PanelId.Sampler -> str(Str.PanelSampler)
    PanelId.Plugins -> str(Str.PanelPlugins)
    PanelId.Waves -> str(Str.PanelWaves)
}

/** Localised name of a layout (built-ins by id; pack layouts keep their own name). */
@Composable
fun layoutName(l: LayoutDoc): String = when (l.id) {
    "pro" -> str(Str.LayoutPro)
    "pro-vertical" -> str(Str.LayoutProVertical)
    "classic" -> str(Str.LayoutClassic)
    "performance" -> str(Str.LayoutPerformance)
    "library" -> str(Str.LayoutLibrary)
    "four-deck" -> str(Str.LayoutFourDeck)
    "ultrawide" -> str(Str.LayoutUltrawide)
    "stage" -> str(Str.LayoutStage)
    else -> l.name
}
