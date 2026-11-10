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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.theme.LocalDecksType

/** Panels this app renders (two decks; no clock / automix / sampler / plugins yet: they go to the dock). */
val NativePanels: Set<PanelId> = setOf(PanelId.DeckA, PanelId.DeckB, PanelId.Mixer, PanelId.Crossfader, PanelId.Library)

/** Width (dp) under which the native phone layout ([DemoPacks.phone]) replaces the chosen one. */
const val PHONE_MAX_WIDTH_DP = 700

/** The layout to solve for a window [widthDp] wide: phones get [DemoPacks.phone]. */
fun effectiveLayout(chosen: LayoutDoc, widthDp: Float): LayoutDoc = if (widthDp < PHONE_MAX_WIDTH_DP) DemoPacks.phone else chosen

/**
 * Zero-scroll layout host (WP19-34, docs/decks/layouts.md "Native apps"): measures the available
 * box, asks the solver (decks-ffi, or [DemoPacks] without the native library) for rects + tiers,
 * places every panel absolutely and puts what does not fit — or what this app does not render —
 * in a tabbed dock at the solver's dock rect. Nothing here scrolls.
 */
@Composable
fun LayoutHost(
    layout: LayoutDoc,
    port: PackPort?,
    modifier: Modifier = Modifier,
    available: Set<PanelId> = NativePanels,
    panel: @Composable (id: PanelId, tier: PanelTier, modifier: Modifier) -> Unit,
) {
    BoxWithConstraints(modifier.fillMaxSize()) {
        val w = maxWidth.value.toDouble()
        val h = maxHeight.value.toDouble()
        val solver = port ?: DemoPacks
        val sol = remember(layout, w, h, available, solver) { solver.solve(layout, w, h, available) }
        Placed(sol, panel)
    }
}

@Composable
private fun Placed(sol: LayoutSolution, panel: @Composable (PanelId, PanelTier, Modifier) -> Unit) {
    val dock = sol.dock
    // Panels the dock shares its slot with (the host panel becomes the first tab).
    val host = dock?.let { d -> sol.placements.firstOrNull { it.rect == d } }
    for (p in sol.placements) {
        if (p === host) continue
        val r = p.rect
        Box(Modifier.offset(r.x.dp, r.y.dp).size(r.w.dp, r.h.dp).semantics { testTag = "panel-${p.panel.key}" }) {
            panel(p.panel, p.tier, Modifier.fillMaxSize())
        }
    }
    if (dock != null) {
        val tabs = listOfNotNull(host?.panel) + sol.docked
        Box(Modifier.offset(dock.x.dp, dock.y.dp).size(dock.w.dp, dock.h.dp).semantics { testTag = "dock" }) {
            Dock(tabs, host?.tier ?: PanelTier.Icon, panel)
        }
    }
}

@Composable
private fun Dock(tabs: List<PanelId>, hostTier: PanelTier, panel: @Composable (PanelId, PanelTier, Modifier) -> Unit) {
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
            if (selected in NativePanels) panel(selected, hostTier, Modifier.fillMaxSize())
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
}

/** Localised name of a layout (built-ins by id; pack layouts keep their own name). */
@Composable
fun layoutName(l: LayoutDoc): String = when (l.id) {
    "classic" -> str(Str.LayoutClassic)
    "performance" -> str(Str.LayoutPerformance)
    "library" -> str(Str.LayoutLibrary)
    "four-deck" -> str(Str.LayoutFourDeck)
    "ultrawide" -> str(Str.LayoutUltrawide)
    "stage" -> str(Str.LayoutStage)
    else -> l.name
}
