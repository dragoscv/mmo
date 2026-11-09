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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.ComposeWaveforms
import ro.mixai.decks.ui.components.PadButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.components.WaveformSlot
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.DeckLayout
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.LocalDecksSkin
import ro.mixai.decks.ui.theme.LocalDecksType
import ro.mixai.decks.ui.theme.LocalReducedMotion
import ro.mixai.decks.ui.theme.SkinState

/**
 * Root of the Decks UI (shared by Android and Desktop).
 * Wide (≥ 1000 dp): layout from the skin ([DeckLayout]): classic (deck A | mixer | deck B, library
 * below), performance (tall waveforms, no jogs) or library-first.
 * Narrow (phones): stacked and scrollable, jog wheels hidden.
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
) {
    val reduced = LocalReducedMotion.current
    val layout = LocalDecksSkin.current.layout
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
        val wide = maxWidth >= 1000.dp
        // Short windows (e.g. 1440×900): scroll the whole page and give the library a fixed height.
        val tall = maxHeight >= 1100.dp
        val peaks = ctl.controls.map { it.peaks }
        val frame = ctl.waveFrame(zoom, reduced)
        Column(Modifier.fillMaxSize().padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusBar(ctl, skins, if (recordPath != null) ({ showSet = !showSet }) else null, { showAi = !showAi }) { showConnect = !showConnect }
            if (showConnect) ConnectPanel(ctl, Modifier.fillMaxWidth())
            if (showAi) AiPanel(ctl, Modifier.fillMaxWidth())
            if (showSet && recordPath != null) SetPanel(ctl, recordPath, onExport, Modifier.fillMaxWidth())
            val waveLabel = str(Str.Waveform)
            val waveH = when {
                !wide -> 110.dp
                layout == DeckLayout.Performance -> 260.dp
                layout == DeckLayout.Library -> 110.dp
                else -> 150.dp
            }
            Box(Modifier.fillMaxWidth().height(waveH)) {
                waveforms(frame, peaks, Modifier.fillMaxSize().semantics { contentDescription = waveLabel })
            }
            val jogs = layout == DeckLayout.Classic
            if (wide && layout == DeckLayout.Library) {
                LibraryPanel(ctl, onScanFolder, Modifier.fillMaxWidth().weight(1f))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DeckPanel(ctl, 0, Modifier.weight(1f), compact = true)
                    MixerPanel(ctl, Modifier.width(280.dp))
                    DeckPanel(ctl, 1, Modifier.weight(1f), compact = true)
                }
            } else if (wide && tall) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DeckPanel(ctl, 0, Modifier.weight(1f), compact = !jogs)
                    MixerPanel(ctl, Modifier.width(280.dp))
                    DeckPanel(ctl, 1, Modifier.weight(1f), compact = !jogs)
                }
                LibraryPanel(ctl, onScanFolder, Modifier.fillMaxWidth().weight(1f))
            } else if (wide) {
                Column(
                    Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        DeckPanel(ctl, 0, Modifier.weight(1f), compact = !jogs)
                        MixerPanel(ctl, Modifier.width(280.dp))
                        DeckPanel(ctl, 1, Modifier.weight(1f), compact = !jogs)
                    }
                    LibraryPanel(ctl, onScanFolder, Modifier.fillMaxWidth().height(360.dp))
                }
            } else {
                Column(
                    Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    DeckPanel(ctl, 0, Modifier.fillMaxWidth(), compact = true)
                    DeckPanel(ctl, 1, Modifier.fillMaxWidth(), compact = true)
                    MixerPanel(ctl, Modifier.fillMaxWidth())
                    LibraryPanel(ctl, onScanFolder, Modifier.fillMaxWidth().height(420.dp))
                }
            }
        }
    }
}

@Composable
private fun StatusBar(ctl: DecksController, skins: SkinState?, onSet: (() -> Unit)?, onAi: () -> Unit, onConnect: () -> Unit) {
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
                // Amber text is below 4.5:1 on light backgrounds: light skins use the foreground role.
                style = type.small.copy(color = when {
                    ctl.backend.isNative -> DecksColors.muted
                    DecksColors.skin.dark -> DecksColors.warning
                    else -> DecksColors.foreground
                }),
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
        }
    }
}

@Composable
fun skinName(s: DecksSkin): String = when (s.id) {
    "club" -> str(Str.SkinClub)
    "booth" -> str(Str.SkinBooth)
    "studio" -> str(Str.SkinStudio)
    "emerald" -> str(Str.SkinEmerald)
    "nocturne" -> str(Str.SkinNocturne)
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
