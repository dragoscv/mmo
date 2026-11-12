package ro.mixai.decks.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.floor
import ro.mixai.decks.ui.DeckControls
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.BtnKind
import ro.mixai.decks.ui.components.CuePad
import ro.mixai.decks.ui.components.FaderLook
import ro.mixai.decks.ui.components.FlatFader
import ro.mixai.decks.ui.components.Glyph
import ro.mixai.decks.ui.components.GlyphIcon
import ro.mixai.decks.ui.components.KeyChip
import ro.mixai.decks.ui.components.LocalRecomposeProbe
import ro.mixai.decks.ui.components.LookLine
import ro.mixai.decks.ui.components.LookText
import ro.mixai.decks.ui.components.MicroLabel
import ro.mixai.decks.ui.components.MorePopup
import ro.mixai.decks.ui.components.OnButton
import ro.mixai.decks.ui.components.PhaseMeter
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.components.Recomposed
import ro.mixai.decks.ui.components.TierTabs
import ro.mixai.decks.ui.components.dashedOutline
import ro.mixai.decks.ui.components.inkOn
import ro.mixai.decks.ui.components.needs
import ro.mixai.decks.ui.components.tag
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.i18n.Counted
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.i18n.strBeats
import ro.mixai.decks.ui.logic.DeckMath
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.model.DeckState
import ro.mixai.decks.ui.model.LoadPhase
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksSkin
import ro.mixai.decks.ui.theme.LocalTouchInput
import ro.mixai.decks.ui.theme.Oklab

/*
 * Deck panel, "MixAI Signature" (Decks 1.5): the Compose mirror of apps/mixai/src/components/Deck.tsx
 * and deck.css. A wide, short strip: header (deck letter, title and artist on one line, key chip,
 * MASTER; then the readouts: BPM in two sizes in the deck colour, tempo %, remaining time first,
 * elapsed second), the overview strip with the phrase band, the transport row (CUE, PLAY, SYNC + lock,
 * Q, SLIP, KEY lock, nudge), the jump / key / tempo row, then HOT CUE · LOOP tabs over 2 × 4 pads.
 *
 * Zero scroll: every row has a fixed height and only the pads flex. WHAT is inline in a given box is
 * decided by `deckFit` (PanelFit.kt, pure and unit-tested); this file renders exactly that. Controls
 * a smaller box has no room for are behind MORE (a popup): nothing is removed (desktopTest
 * ControlPresenceTest looks every control of the full deck up in the panel or the sheet, per tier). The
 * sheet of a deck whose MORE is in the header opens over that deck's own CUE / PLAY, so it carries a
 * CUE and a PLAY of its own: the deck stops with one tap while the sheet is open.
 *
 * State: the engine snapshot changes 60 times a second (playhead, beat, level). The panel composes
 * from `DeckView`, the part of it that does not move every frame, so a playing deck does not
 * recompose; the moving values are read only by the leaves that show them: the overview, the phase
 * meter and the progress line while drawing, the two time readouts through a derived state that
 * changes when their text does (desktopTest RecompositionTest counts both).
 *
 * Colour: ON is the look's ON colour (green) on every toggle. The deck colour is identity only: the
 * letter, the BPM digits, the overview, the 2 dp line along the top, and PLAY (unless the skin fixes
 * a PLAY colour). CUE has its own colour; the end of the track has the alert colour plus a word and
 * an icon, never colour alone.
 */

/** Lower area of a deck. FX, stems and the grid editor have no engine port in this app yet (the grid editor opens from the status bar). */
enum class DeckTab { Cues, Loops }

/** Test names of a deck's controls and readouts ([tag]): not spoken, not shown. */
object DeckTags {
    const val PLAY = "deck-play"
    const val CUE = "deck-cue"
    const val SYNC = "deck-sync"
    const val SYNC_LOCK = "deck-sync-lock"
    const val QUANTIZE = "deck-quantize"
    const val SLIP = "deck-slip"
    const val KEY_LOCK = "deck-key-lock"
    const val NUDGE_BACK = "deck-nudge-back"
    const val NUDGE_FORWARD = "deck-nudge-forward"
    const val KEY_DOWN = "deck-key-down"
    const val KEY_UP = "deck-key-up"
    const val KEY_MATCH = "deck-key-match"
    const val JUMP_BACK = "deck-jump-back"
    const val JUMP_SIZE = "deck-jump-size"
    const val JUMP_FORWARD = "deck-jump-forward"
    const val TEMPO_DOWN = "deck-tempo-down"
    const val TEMPO = "deck-tempo"
    const val TEMPO_UP = "deck-tempo-up"
    const val TEMPO_RANGE = "deck-tempo-range"
    const val TEMPO_RESET = "deck-tempo-reset"
    const val SEEK = "deck-seek"
    const val TAB_CUES = "deck-tab-cues"
    const val TAB_LOOPS = "deck-tab-loops"
    const val CUE_DELETE = "deck-cue-delete"
    const val LOOP = "deck-loop"
    const val LOOP_HALVE = "deck-loop-halve"
    const val LOOP_DOUBLE = "deck-loop-double"
    const val LOOP_IN = "deck-loop-in"
    const val LOOP_OUT = "deck-loop-out"
    const val MORE = "deck-more"
    const val SHEET = "deck-sheet"
    const val CLOSE = "deck-sheet-close"
    const val TITLE = "deck-title"
    const val KEY = "deck-key"
    const val BPM = "deck-bpm"
    const val REMAIN = "deck-remaining"
    const val ELAPSED = "deck-elapsed"
    const val MASTER = "deck-master"
    const val PHASE = "deck-phase"

    fun pad(slot: Int): String = "deck-pad-${slot + 1}"
    fun loopSize(beats: Double): String = "deck-loop-size-${DeckMath.loopLabel(beats)}"

    /**
     * Every control of the full deck. HOT CUE and LOOP are tabs: the pads (and the delete-cues toggle) show on
     * one, the loop sizes and IN / OUT on the other. Every arrangement has all of these in the panel or in its
     * MORE sheet.
     */
    val CONTROLS: List<String> = listOf(
        CUE, PLAY, SYNC, SYNC_LOCK, QUANTIZE, SLIP, KEY_LOCK, NUDGE_BACK, NUDGE_FORWARD, KEY_DOWN, KEY_UP, KEY_MATCH,
        JUMP_BACK, JUMP_SIZE, JUMP_FORWARD, TEMPO_DOWN, TEMPO, TEMPO_UP, TEMPO_RANGE, TEMPO_RESET, SEEK,
        TAB_CUES, TAB_LOOPS, CUE_DELETE, LOOP, LOOP_HALVE, LOOP_DOUBLE, LOOP_IN, LOOP_OUT,
    ) + List(8) { pad(it) } + DeckMath.LOOP_SIZES.map { loopSize(it) }

    /** Readouts every arrangement has in the panel or in its MORE sheet (elapsed time and the phase meter are full-deck only). */
    val READOUTS: List<String> = listOf(TITLE, KEY, BPM, REMAIN, MASTER)
}

/** Names the deck reports to [LocalRecomposeProbe] (desktopTest/RecompositionTest). */
object DeckProbe {
    const val PANEL = "deck"
    const val TRANSPORT = "deck:transport"
    const val PLAY = "deck:play"
    const val PADS = "deck:pads"
    const val REMAIN = "deck:remain"
    const val OVERVIEW_DRAW = "deck:overview:draw"
}

/** One nudge step (seconds). */
private const val NUDGE_SEC = 0.02

/** Beat-jump sizes the size cell cycles through. */
private val JUMP_SIZES = listOf(1.0, 2.0, 4.0, 8.0, 16.0, 32.0)

/**
 * What the parts of one deck panel share. Stable: [v] is a value, the rest are the same instances for the life
 * of the panel, so a part that got the same [DeckUi] is skipped.
 */
@Stable
private class DeckUi(
    val ctl: DecksController,
    val index: Int,
    /** The slow part of the deck's state: what the parts compose from. */
    val v: DeckView,
    /**
     * The deck's 60 Hz snapshot. Called only where a moving value is shown, and only inside a draw block, a derived
     * state or an event handler: a call in a composable body would recompose that composable every frame.
     */
    val live: () -> DeckState,
    val c: DeckControls,
    val name: String,
    val fit: DeckFit,
    val tab: MutableState<DeckTab>,
    val more: MutableState<Boolean>,
) {
    val letter: String get() = if (index == 0) "A" else "B"
    val warn: RemainWarn get() = v.warn
}

/**
 * One deck in the box the layout solver gave it. [tier] is the solver's tier (`PANEL_SPECS`: full
 * from 480×250, compact from 340×190, icon from 220×110 dp); the arrangement inside is [deckFit], with
 * a small dead band while the box is being resized ([FitLag]).
 * [initialTab] = the tab of the lower area the deck opens on; [initialMore] = it opens with its MORE
 * sheet showing (both are for previews and tests).
 */
@Composable
fun DeckPanel(
    ctl: DecksController,
    index: Int,
    modifier: Modifier = Modifier,
    tier: PanelTier = PanelTier.Full,
    initialTab: DeckTab = DeckTab.Cues,
    initialMore: Boolean = false,
) {
    Recomposed(DeckProbe.PANEL)
    // The deck's own snapshot as a derived state: the engine publishes a new snapshot of ALL decks every frame, but
    // an idle deck's part of it stays equal, so nothing that reads `live` is invalidated while only the other deck plays.
    val snapshot = remember(ctl, index) { derivedStateOf { ctl.deck(index) ?: DeckState(index) } }
    val live: () -> DeckState = remember(snapshot) { { snapshot.value } }
    // Derived from the 60 Hz snapshot, equal while only the moving values change: the panel recomposes when it changes.
    val view by remember(ctl, index) { derivedStateOf { deckView(ctl.deck(index) ?: DeckState(index), ctl.engine.clock.sourceDeck) } }
    val c = ctl.controls[index]
    val name = str(if (index == 0) Str.DeckA else Str.DeckB)
    val tab = remember(index) { mutableStateOf(initialTab) }
    val more = remember(index) { mutableStateOf(initialMore) }
    val lag = remember(index) { FitLag() }
    val deck = DecksColors.deck(index)
    val alert = DecksColors.alert
    val playing = view.playing
    val warn = view.warn
    val ending = "${str(Str.Ending)}: $name"
    BoxWithConstraints(modifier) {
        val w = maxWidth.value.toDouble()
        val h = maxHeight.value.toDouble()
        val box = remember(lag, tier, w, h) { lag.settle(if (index == 0) PanelId.DeckA else PanelId.DeckB, tier, w, h) }
        val fit = remember(box) { deckFit(box.tier, box.w, box.h) }
        val ui = remember(ctl, index, view, live, c, name, fit, tab, more) { DeckUi(ctl, index, view, live, c, name, fit, tab, more) }
        // Identity = a 2 dp line in the deck colour along the top (dim until the deck plays); the end of the
        // track = a 2 dp frame in the alert colour (the header also shows the word and an icon).
        val decoration = Modifier.drawBehind {
            drawRect(deck.copy(alpha = if (playing) 1f else 0.45f), size = Size(size.width, 2.dp.toPx()))
            if (warn != RemainWarn.None) {
                val s = 2.dp.toPx()
                drawRect(alert, Offset(s / 2, s / 2), Size(size.width - s, size.height - s), style = Stroke(s))
            }
        }
        Panel(
            Modifier.fillMaxSize().semantics { contentDescription = name },
            verticalPad = fit.pad.dp, horizontalPad = fit.pad.dp, decoration = decoration,
        ) {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(fit.gap.dp)) {
                if (fit.twoRowHeader) FullHeader(ui) else LineHeader(ui)
                if (fit.readoutRow) MiniReadouts(ui, Modifier.height(22.dp).fillMaxWidth(), spread = true)
                if (fit.waveH > 0) OverviewStrip(ui, Modifier.fillMaxWidth().height(fit.waveH.dp))
                if (fit.phase) PhaseStrip(ui)
                // Without pads or tabs no row flexes: the transport row then takes what the arrangement leaves.
                Transport(ui, if (fit.transportFlex) Modifier.weight(1f) else Modifier.height(fit.tpH.dp))
                if (fit.util) UtilRow(ui, Modifier.fillMaxWidth())
                if (fit.tabs) {
                    TabRow(ui)
                    Box(Modifier.weight(1f).fillMaxWidth()) { TabBody(ui, ui.tab.value, Modifier.fillMaxSize()) }
                } else if (fit.padRows > 0) {
                    HotCuePads(ui, fit.padRows, Modifier.weight(1f).fillMaxWidth())
                }
                if (fit.loopRow) LoopRow(ui, short = true)
                if (fit.waveH == 0) ProgressLine(ui)
            }
            // Said once when the warning starts: the text stays the same while it lasts.
            if (warn != RemainWarn.None) {
                Box(Modifier.size(1.dp).semantics { liveRegion = LiveRegionMode.Polite; contentDescription = ending })
            }
        }
    }
}

/* ── header ───────────────────────────────────────────────────────────── */

@Composable
private fun chipShape() = RoundedCornerShape(LocalDecksSkin.current.controlRadiusDp.dp)

/** The deck letter on the deck colour. */
@Composable
private fun DeckBadge(ui: DeckUi, size: Dp) {
    val color = DecksColors.deck(ui.index)
    Box(Modifier.size(size).background(color, chipShape()), contentAlignment = Alignment.Center) {
        LookLine(ui.letter, LookText.style(if (size >= 20.dp) 13f else 12f, inkOn(color), FontWeight.ExtraBold, line = 14f))
    }
}

@Composable
private fun titleText(ui: DeckUi): String = when {
    ui.c.loadPhase == LoadPhase.FAILED -> str(Str.LoadFailed, ui.c.loadError ?: "?")
    ui.c.loadPhase == LoadPhase.QUEUED -> str(Str.LoadQueued)
    ui.c.loadPhase == LoadPhase.DECODING -> str(Str.LoadDecoding)
    ui.c.loadPhase == LoadPhase.ANALYSING -> str(Str.LoadAnalysing)
    ui.c.loadPhase != null || ui.v.loading -> str(Str.Loading)
    else -> ui.v.title ?: str(Str.NoTrack)
}

/** Title (bold) then artist (muted) on ONE line that fills the row and ends in an ellipsis: the artist is cut first. */
@Composable
private fun RowScope.TitleArtist(ui: DeckUi, px: Float, artist: Boolean) {
    val empty = ui.v.title == null
    val name = ui.ctl.deckRow(ui.index)?.artist.orEmpty()
    val dim = DecksColors.muted
    val small = LookText.sp(11f)
    val title = titleText(ui)
    val text = buildAnnotatedString {
        append(title)
        if (artist && name.isNotEmpty() && ui.c.loadPhase == null) {
            withStyle(SpanStyle(color = dim, fontWeight = FontWeight.Normal, fontSize = small)) { append("  $name") }
        }
    }
    BasicText(
        text, Modifier.weight(1f).needs("deck title", 40.dp, 12.dp).tag(DeckTags.TITLE).semantics { heading() },
        LookText.style(px, if (empty) dim else DecksColors.foreground, if (empty) FontWeight.SemiBold else FontWeight.Bold, line = px + 4f),
        overflow = TextOverflow.Ellipsis, softWrap = false, maxLines = 1,
    )
}

/** The playing key on its Camelot colour; [shift] adds the key shift in semitones when it is not zero. */
@Composable
private fun DeckKeyChip(ui: DeckUi, shift: Boolean) {
    KeyChip(ui.v.key, Modifier.tag(DeckTags.KEY), suffix = if (shift && ui.c.keyShift != 0.0) " ${Format.semitones(ui.c.keyShift)}" else "")
}

/** MASTER: a status, not a control. Filled = this deck drives the clock; a dashed outline = it does not. */
@Composable
private fun MasterBadge(ui: DeckUi) {
    val on = ui.v.master
    val label = str(Str.Master)
    val state = str(if (on) Str.On else Str.Off)
    val shape = chipShape()
    val radius = LocalDecksSkin.current.controlRadiusDp.dp
    Box(
        Modifier.height(18.dp)
            .then(if (on) Modifier.background(DecksColors.on, shape) else Modifier.dashedOutline(DecksColors.border, radius))
            .padding(horizontal = 6.dp)
            .tag(DeckTags.MASTER)
            .semantics(mergeDescendants = true) { stateDescription = state },
        contentAlignment = Alignment.Center,
    ) {
        MicroLabel(label, color = if (on) DecksColors.onFg else DecksColors.faint)
    }
}

/** End-of-track chip: an icon and a word in an outline of the alert colour. */
@Composable
private fun EndingChip() {
    val alert = DecksColors.alert
    Row(
        Modifier.height(18.dp).border(1.dp, alert, chipShape()).padding(horizontal = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        GlyphIcon(Glyph.Warn, alert, size = 10.dp)
        MicroLabel(str(Str.Ending), color = DecksColors.foreground)
    }
}

/** BPM in two sizes ("124" + ".00") in the deck colour; "---" dimmed without a tempo. */
@Composable
private fun BpmValue(ui: DeckUi, px: Float, modifier: Modifier = Modifier) {
    val text = ui.v.bpmText
    val color = DecksColors.deck(ui.index)
    val spoken = "${str(Str.Bpm)} $text"
    Row(modifier.tag(DeckTags.BPM).semantics(mergeDescendants = true) { contentDescription = spoken }) {
        if ('.' !in text) {
            LookLine("---", LookText.num(px, DecksColors.muted), Modifier.alignByBaseline())
        } else {
            LookLine(text.substringBefore('.'), LookText.num(px, color), Modifier.alignByBaseline())
            LookLine("." + text.substringAfter('.'), LookText.num(px * 0.58f, color, FontWeight.SemiBold), Modifier.alignByBaseline())
        }
    }
}

/**
 * Remaining time ("−06:12.4"): the primary time. [tenths] off = whole seconds. Alert colour while the track ends.
 * The time comes from a derived state: this readout recomposes when its text changes (ten times a second with
 * tenths, once a second without), and nothing around it does.
 */
@Composable
private fun RemainValue(ui: DeckUi, px: Float, tenths: Boolean, modifier: Modifier = Modifier) {
    Recomposed(DeckProbe.REMAIN)
    val color = if (ui.warn != RemainWarn.None) DecksColors.alert else DecksColors.foreground
    val spoken = str(Str.Remaining)
    val live = ui.live
    val time by remember(live, tenths) { derivedStateOf { splitTime(remainingSec(live())).let { if (tenths) it else it.first to "" } } }
    Row(modifier.tag(DeckTags.REMAIN).semantics(mergeDescendants = true) { contentDescription = spoken }) {
        if (!ui.v.loaded) {
            LookLine("--:--", LookText.num(px, DecksColors.muted), Modifier.alignByBaseline())
        } else {
            LookLine("\u2212${time.first}", LookText.num(px, color), Modifier.alignByBaseline())
            if (tenths) LookLine(".${time.second}", LookText.num(px * 0.58f, color, FontWeight.SemiBold), Modifier.alignByBaseline())
        }
    }
}

/** Elapsed time: secondary, grey. Recomposes when its text changes, like [RemainValue]. */
@Composable
private fun ElapsedValue(ui: DeckUi, modifier: Modifier = Modifier) {
    val dim = DecksColors.muted
    val spoken = str(Str.Elapsed)
    val live = ui.live
    val time by remember(live) { derivedStateOf { splitTime(live().playheadSec) } }
    Row(modifier.tag(DeckTags.ELAPSED).semantics(mergeDescendants = true) { contentDescription = spoken }) {
        if (!ui.v.loaded) {
            LookLine("--:--", LookText.num(11f, dim, FontWeight.SemiBold), Modifier.alignByBaseline())
        } else {
            LookLine(time.first, LookText.num(11f, dim, FontWeight.SemiBold), Modifier.alignByBaseline())
            LookLine(".${time.second}", LookText.num(7f, dim, FontWeight.SemiBold), Modifier.alignByBaseline())
        }
    }
}

/** A readout with its caption (9 dp caps) in front; captions and values of the whole row share one text baseline. */
@Composable
private fun RowScope.Readout(caption: String?, value: @Composable RowScope.() -> Unit) {
    Row(Modifier.alignByBaseline(), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        if (caption != null) MicroLabel(caption, Modifier.alignByBaseline())
        value()
    }
}

/** Two-row header of the full tier: title row, then the readouts right-aligned on one baseline. */
@Composable
private fun FullHeader(ui: DeckUi) {
    val f = ui.fit
    val short = f.row1 < 22
    Column(Modifier.height(f.headerH.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(Modifier.height(f.row1.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            DeckBadge(ui, if (short) 18.dp else 20.dp)
            TitleArtist(ui, if (short) 13f else 14f, artist = f.artist)
            if (ui.warn != RemainWarn.None) EndingChip()
            DeckKeyChip(ui, shift = true)
            MasterBadge(ui)
        }
        val shifted = ui.v.tempoShifted
        Row(
            Modifier.height(f.row2.dp).fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(if (f.captions) 14.dp else 12.dp, Alignment.End), verticalAlignment = Alignment.Bottom,
        ) {
            Readout(if (f.captions) str(Str.Bpm) else null) { BpmValue(ui, if (short) 24f else 28f, Modifier.alignByBaseline()) }
            Readout(if (f.captions) str(Str.Tempo) else null) {
                LookLine(ui.v.tempoText, LookText.num(13f, if (shifted) DecksColors.foreground else DecksColors.muted, FontWeight.SemiBold), Modifier.alignByBaseline())
            }
            Readout(if (f.captions) str(Str.Remaining) else null) { RemainValue(ui, if (short) 18f else 20f, tenths = true, Modifier.alignByBaseline()) }
            Readout(if (f.captions) str(Str.Elapsed) else null) { ElapsedValue(ui, Modifier.alignByBaseline()) }
        }
    }
}

/**
 * One-line header (compact, icon): letter, title, then key chip + BPM + remaining (compact), or MORE
 * (icon: the readouts have their own row). In a box the solver forced under the icon minimum there is
 * no readout row: the remaining time joins the title (a DJ needs time-to-end first), and the BPM too
 * when a 40 dp title still fits beside both (`DeckFit.headerBpm`; else the BPM is in the MORE sheet).
 */
@Composable
private fun LineHeader(ui: DeckUi) {
    val f = ui.fit
    Row(Modifier.height(24.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        DeckBadge(ui, 18.dp)
        TitleArtist(ui, 12f, artist = f.artist)
        if (!f.readoutRow && !f.moreInHeader) {
            DeckKeyChip(ui, shift = false)
            MiniReadouts(ui, Modifier, spread = false)
            // A wide compact deck has everything inline and no MORE sheet: its MASTER status is here.
            if (!f.more) MasterBadge(ui)
        }
        if (!f.readoutRow && f.moreInHeader) {
            if (f.headerBpm) BpmValue(ui, 15f)
            RemainValue(ui, 15f, tenths = false)
        }
        if (f.more && f.moreInHeader) MoreButton(ui)
    }
}

/** BPM + remaining on one line (compact header, icon tier); the warning icon sits by the time. */
@Composable
private fun MiniReadouts(ui: DeckUi, modifier: Modifier, spread: Boolean) {
    Row(modifier, horizontalArrangement = if (spread) Arrangement.SpaceBetween else Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        BpmValue(ui, 15f)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (ui.warn != RemainWarn.None) GlyphIcon(Glyph.Warn, DecksColors.alert, size = 12.dp)
            RemainValue(ui, 15f, tenths = false)
        }
    }
}

/* ── overview ─────────────────────────────────────────────────────────── */

/** The playhead as it is spoken: whole seconds, so the text and the fraction change once a second. */
private data class SpokenPosition(val text: String, val fraction: Float)

private fun spokenPositionOf(d: DeckState): SpokenPosition {
    val sec = floor(maxOf(0.0, d.playheadSec))
    val fraction = if (d.durationSec > 0) (sec / d.durationSec).toFloat().coerceIn(0f, 1f) else 0f
    return SpokenPosition("${splitTime(sec).first} / ${splitTime(d.durationSec).first}", fraction)
}

@Composable
private fun spokenPosition(ui: DeckUi): State<SpokenPosition> {
    val live = ui.live
    return remember(live) { derivedStateOf { spokenPositionOf(live()) } }
}

private fun playedFraction(d: DeckState): Float = if (d.durationSec > 0) (d.playheadSec / d.durationSec).toFloat().coerceIn(0f, 1f) else 0f

/**
 * Overview of the whole track, also the seek control: the peaks in the deck colour with the played
 * part dimmed by the look, hot cues, the active loop, the playhead, and the phrase band along the
 * bottom (intro / outro greys, break in a deck tint, build in the warning colour, main in the deck
 * colour). Tap seeks; Left / Right seek ±5 %. The playhead is read while drawing (the strip redraws
 * every frame, it does not recompose); the spoken position moves once a second.
 */
@Composable
private fun OverviewStrip(ui: DeckUi, modifier: Modifier) {
    val v = ui.v
    val live = ui.live
    val peaks = ui.c.peaks
    val bpm = v.bpm ?: ui.c.meta?.bpm
    val firstBeat = ui.c.meta?.firstBeatSec ?: 0.0
    val duration = v.durationSec
    val phrases = remember(peaks, bpm, firstBeat, duration) { Phrases.detect(peaks, bpm, firstBeat, duration) }
    val ctl = ui.ctl
    val index = ui.index
    val seekable = v.loaded && duration > 0
    val description = "${str(Str.Overview)} ${ui.name}"
    val spoken by spokenPosition(ui)
    val position = spoken.text
    val fraction = spoken.fraction
    val deck = DecksColors.deck(index)
    val bg = DecksColors.waveBg
    val fg = DecksColors.foreground
    val warning = DecksColors.warning
    val playedAlpha = DecksColors.wavePlayedAlpha
    val loopFill = DecksColors.success
    val cues = List(8) { DecksColors.cue(it) }
    val drawn = LocalRecomposeProbe.current
    val phraseColors = remember(deck, bg, fg, warning) {
        mapOf(
            PhraseKind.Intro to Oklab.mix(fg, bg, 0.42f), PhraseKind.Outro to Oklab.mix(fg, bg, 0.26f),
            PhraseKind.Break to Oklab.mix(deck, bg, 0.42f), PhraseKind.Build to warning, PhraseKind.Main to deck,
        )
    }
    Canvas(
        modifier.clip(chipShape())
            .needs(description, 24.dp, 24.dp)
            .pointerInput(index, seekable) { detectTapGestures { if (seekable) ctl.seekFraction(index, it.x / size.width) } }
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown || !seekable) return@onKeyEvent false
                val at = playedFraction(live())
                when (e.key) {
                    Key.DirectionLeft -> { ctl.seekFraction(index, (at - 0.05f).coerceAtLeast(0f)); true }
                    Key.DirectionRight -> { ctl.seekFraction(index, (at + 0.05f).coerceAtMost(1f)); true }
                    else -> false
                }
            }
            .focusable()
            .tag(DeckTags.SEEK)
            .semantics {
                contentDescription = description
                stateDescription = position
                progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f)
            },
    ) {
        // The 60 Hz read: in the draw block, so a moving playhead redraws this strip and recomposes nothing.
        val d = live()
        drawn?.invoke(DeckProbe.OVERVIEW_DRAW)
        val frac = playedFraction(d)
        drawRect(bg)
        val band = if (phrases.isNotEmpty()) 4.dp.toPx() else 0f
        val waveH = size.height - band
        val mid = waveH / 2
        if (peaks != null && peaks.size > 0) {
            val cols = size.width.toInt().coerceAtLeast(1)
            val per = peaks.size.toFloat() / cols
            val playedCols = frac * cols
            for (col in 0 until cols) {
                val a = (col * per).toInt().coerceAtMost(peaks.size - 1)
                val b = ((col + 1) * per).toInt().coerceIn(a + 1, peaks.size)
                var m = 0
                for (k in a until b) m = maxOf(m, peaks.low[k].toInt() and 0xFF, peaks.mid[k].toInt() and 0xFF)
                val half = m / 255f * mid * 0.92f
                val x = col + 0.5f
                drawLine(deck, Offset(x, mid - half), Offset(x, mid + half), 1f, alpha = if (col < playedCols) playedAlpha else 1f)
            }
        } else {
            drawLine(fg.copy(alpha = 0.24f), Offset(0f, mid), Offset(size.width, mid), 1f)
        }
        if (d.loaded && d.durationSec > 0) {
            fun x(sec: Double) = (sec / d.durationSec * size.width).toFloat()
            if (d.loopActive && d.loopEndSec > d.loopStartSec) {
                drawRect(loopFill.copy(alpha = 0.22f), Offset(x(d.loopStartSec), 0f), Size(x(d.loopEndSec) - x(d.loopStartSec), waveH))
            }
            d.hotCues.forEachIndexed { i, at -> if (at != null) drawLine(cues[i % cues.size], Offset(x(at), 0f), Offset(x(at), waveH), 2.dp.toPx()) }
            for (ph in phrases) {
                val x0 = x(ph.fromSec)
                val x1 = x(ph.toSec) - 1f
                // The played part of the band is dimmed like the wave.
                if (x1 > x0) drawRect(phraseColors.getValue(ph.kind), Offset(x0, waveH), Size(x1 - x0, band), alpha = if (ph.toSec <= d.playheadSec) 0.5f else 1f)
            }
            val px = frac * size.width
            drawLine(fg, Offset(px, 0f), Offset(px, size.height), 2.dp.toPx())
        }
    }
}

/** Phase against the master clock (−½ … +½ beat, centre = in phase); empty on the master deck itself. Read while drawing. */
@Composable
private fun PhaseStrip(ui: DeckUi) {
    val ctl = ui.ctl
    val index = ui.index
    val live = ui.live
    PhaseMeter(
        offsetBeats = {
            val d = live()
            val master = ctl.engine.clock
            if (d.loaded && d.bpm != null && master.bpm > 0 && master.sourceDeck != index) DeckMath.phaseOffset(d.beat, master.beat) else null
        },
        deckIndex = index,
        description = "${str(Str.PhaseMeter)} ${ui.name}",
        modifier = Modifier.fillMaxWidth().height(DeckFit.PHASE.dp).tag(DeckTags.PHASE),
    )
}

/** Track progress of the smallest icon box: a 3 dp line (alert colour while the track ends). Read while drawing. */
@Composable
private fun ProgressLine(ui: DeckUi) {
    val live = ui.live
    val description = "${str(Str.Overview)} ${ui.name}"
    val spoken by spokenPosition(ui)
    val position = spoken.text
    val fraction = spoken.fraction
    val fill = if (ui.warn != RemainWarn.None) DecksColors.alert else DecksColors.deck(ui.index)
    val track = DecksColors.surfaceRaised
    Canvas(
        Modifier.height(3.dp).fillMaxWidth().semantics {
            contentDescription = description
            stateDescription = position
            progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f)
        },
    ) {
        val frac = playedFraction(live())
        drawRect(track)
        drawRect(fill, size = Size(size.width * frac, size.height))
    }
}

/* ── transport ────────────────────────────────────────────────────────── */

/** [modifier] gives the row its height: the arrangement's `tpH`, or the room that is left when no other row flexes. */
@Composable
private fun Transport(ui: DeckUi, modifier: Modifier) {
    Recomposed(DeckProbe.TRANSPORT)
    val f = ui.fit
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        CueButton(ui, Modifier.width(f.cueW.dp).fillMaxHeight())
        PlayButton(ui, if (f.playW > 0) Modifier.width(f.playW.dp).fillMaxHeight() else Modifier.weight(1f).fillMaxHeight())
        if (f.sync) SyncButton(ui)
        if (f.toggles) {
            SyncLockButton(ui)
            ModeToggles(ui)
            KeyLockButton(ui)
        }
        if (f.playW > 0) Box(Modifier.weight(1f))
        if (f.toggles) NudgeCells(ui)
        if (f.keysInTransport) KeyControls(ui)
        if (f.stepper) TempoStepper(ui)
        if (f.more && !f.moreInHeader) MoreButton(ui)
    }
}

/**
 * PLAY: lit = a solid fill in the PLAY colour (the deck colour unless the skin fixes one), and the icon and word change.
 * [word] = the word shows next to the icon (the arrangement decides for the panel's own PLAY).
 */
@Composable
private fun PlayButton(ui: DeckUi, modifier: Modifier, word: Boolean = ui.fit.playWord) {
    Recomposed(DeckProbe.PLAY)
    val playing = ui.v.playing
    val name = str(if (playing) Str.Pause else Str.Play)
    OnButton(
        if (word) name.uppercase() else null, "$name ${ui.name}", modifier.tag(DeckTags.PLAY), on = playing, enabled = ui.v.loaded,
        glyph = if (playing) Glyph.Pause else Glyph.Play, kind = BtnKind.Play, accent = DecksColors.play(ui.index), padH = 4.dp,
        state = str(if (playing) Str.On else Str.Off),
    ) { ui.ctl.togglePlay(ui.index) }
}

/** CUE (momentary): outlined in the CUE colour, solid while held and while the deck rests on the cue point. */
@Composable
private fun CueButton(ui: DeckUi, modifier: Modifier) {
    val word = str(Str.Cue)
    OnButton(
        word.uppercase(), "$word ${ui.name}", modifier.tag(DeckTags.CUE), on = ui.v.atCue, enabled = ui.v.loaded, kind = BtnKind.Cue, padH = 2.dp,
        onPress = { ui.ctl.cue(ui.index, true) }, onRelease = { ui.ctl.cue(ui.index, false) },
    )
}

/** SYNC: a tap matches the tempo and phase once; lit while the deck is locked to the master (a tap then unlocks). */
@Composable
private fun SyncButton(ui: DeckUi) {
    val on = ui.v.syncLock
    val word = str(Str.Sync)
    OnButton(
        word.uppercase(), "$word ${ui.name}", Modifier.fillMaxHeight().tag(DeckTags.SYNC), on = on, enabled = ui.v.loaded,
        state = str(if (on) Str.On else Str.Off), padH = 6.dp,
    ) { ui.ctl.syncTap(ui.index) }
}

@Composable
private fun SyncLockButton(ui: DeckUi) {
    val on = ui.v.syncLock
    OnButton(
        null, "${str(Str.SyncLock)} ${ui.name}", Modifier.fillMaxHeight().tag(DeckTags.SYNC_LOCK), on = on, enabled = ui.v.loaded,
        glyph = if (on) Glyph.Lock else Glyph.Unlock, state = str(if (on) Str.On else Str.Off),
    ) { ui.ctl.syncLock(ui.index) }
}

/** Q (quantize) and SLIP. */
@Composable
private fun ModeToggles(ui: DeckUi) {
    val q = ui.v.quantize
    val slip = ui.v.slip
    OnButton("Q", "${str(Str.Quantize)} ${ui.name}", Modifier.fillMaxHeight().tag(DeckTags.QUANTIZE), on = q, state = str(if (q) Str.On else Str.Off), padH = 6.dp) {
        ui.ctl.toggleQuantize(ui.index)
    }
    OnButton(
        str(Str.Slip).uppercase(), "${str(Str.Slip)} ${ui.name}", Modifier.fillMaxHeight().tag(DeckTags.SLIP), on = slip,
        state = str(if (slip) Str.On else Str.Off), padH = 6.dp,
    ) { ui.ctl.toggleSlip(ui.index) }
}

/** ◀ ▶: nudge the playhead by 20 ms (what the arrow keys of the 1.4 jog wheel did). */
@Composable
private fun NudgeCells(ui: DeckUi) {
    Row(Modifier.fillMaxHeight(), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        OnButton(
            null, "${str(Str.NudgeBack)} ${ui.name}", Modifier.width(24.dp).fillMaxHeight().tag(DeckTags.NUDGE_BACK),
            glyph = Glyph.Left, kind = BtnKind.Cell, enabled = ui.v.loaded,
        ) { ui.ctl.nudge(ui.index, -NUDGE_SEC) }
        OnButton(
            null, "${str(Str.NudgeForward)} ${ui.name}", Modifier.width(24.dp).fillMaxHeight().tag(DeckTags.NUDGE_FORWARD),
            glyph = Glyph.Right, kind = BtnKind.Cell, enabled = ui.v.loaded,
        ) { ui.ctl.nudge(ui.index, NUDGE_SEC) }
    }
}

/** Key lock: the lock closes and the button is lit while on. Its word is "KEY" in every language, as on the desktop deck. */
@Composable
private fun KeyLockButton(ui: DeckUi) {
    val on = ui.v.keyLock
    OnButton(
        str(Str.KeyLockShort).uppercase(), "${str(Str.KeyLock)} ${ui.name}", Modifier.fillMaxHeight().tag(DeckTags.KEY_LOCK), on = on,
        glyph = if (on) Glyph.Lock else Glyph.Unlock, state = str(if (on) Str.On else Str.Off), padH = 6.dp,
    ) { ui.ctl.toggleKeyLock(ui.index) }
}

/* ── jump / key / tempo ───────────────────────────────────────────────── */

@Composable
private fun UtilRow(ui: DeckUi, modifier: Modifier) {
    Row(modifier.height(24.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        BeatJump(ui)
        if (!ui.fit.keysInTransport) KeyControls(ui)
        TempoFader(ui, Modifier.weight(1f), label = ui.fit.captions)
    }
}

/** ◀◀ n ▶▶: beat jump back / forward; the size cell cycles 1 … 32 beats. */
@Composable
private fun BeatJump(ui: DeckUi) {
    val size = DeckMath.loopLabel(ui.c.jumpBeats)
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        OnButton(
            null, "${str(Str.BeatJumpBack, size)} ${ui.name}", Modifier.size(24.dp).tag(DeckTags.JUMP_BACK),
            glyph = Glyph.Rewind, kind = BtnKind.Cell, enabled = ui.v.loaded,
        ) { ui.ctl.beatJump(ui.index, false) }
        OnButton(size, strBeats(Counted.JumpSize, size), Modifier.width(30.dp).height(24.dp).tag(DeckTags.JUMP_SIZE), kind = BtnKind.Cell, padH = 0.dp) {
            val i = JUMP_SIZES.indexOfFirst { sameBeats(it, ui.c.jumpBeats) }
            ui.c.jumpBeats = JUMP_SIZES[(i + 1).mod(JUMP_SIZES.size)]
        }
        OnButton(
            null, "${str(Str.BeatJumpForward, size)} ${ui.name}", Modifier.size(24.dp).tag(DeckTags.JUMP_FORWARD),
            glyph = Glyph.Forward, kind = BtnKind.Cell, enabled = ui.v.loaded,
        ) { ui.ctl.beatJump(ui.index, true) }
    }
}

/** ♭ ♯ MATCH: key shift down / up and key match; the shift in semitones shows when it is not zero. */
@Composable
private fun KeyControls(ui: DeckUi) {
    Row(Modifier.height(24.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        OnButton(
            "\u266D", "${str(Str.KeyShiftDown)} ${ui.name}", Modifier.size(24.dp).tag(DeckTags.KEY_DOWN),
            kind = BtnKind.Cell, enabled = ui.v.loaded, padH = 0.dp,
        ) { ui.ctl.shiftKey(ui.index, -1.0) }
        OnButton(
            "\u266F", "${str(Str.KeyShiftUp)} ${ui.name}", Modifier.size(24.dp).tag(DeckTags.KEY_UP),
            kind = BtnKind.Cell, enabled = ui.v.loaded, padH = 0.dp,
        ) { ui.ctl.shiftKey(ui.index, 1.0) }
        OnButton(
            str(Str.MatchShort).uppercase(), "${str(Str.KeyMatch)} ${ui.name}", Modifier.height(24.dp).tag(DeckTags.KEY_MATCH),
            kind = BtnKind.Cell, enabled = ui.v.loaded, padH = 5.dp,
        ) { ui.ctl.keyMatch(ui.index) }
    }
}

/** −  [flat fader with a centre detent]  +  ±range  value (activating the value resets the tempo). */
@Composable
private fun TempoFader(ui: DeckUi, modifier: Modifier, label: Boolean) {
    val text = ui.v.tempoText
    val rangePct = (ui.c.tempoRange * 100).toInt()
    // One step = 0.1 % of tempo, whatever the range.
    val step = (0.001 / ui.c.tempoRange).toFloat()
    Row(modifier.height(24.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        if (label) MicroLabel(str(Str.Tempo), Modifier.padding(end = 3.dp))
        OnButton(null, "${str(Str.TempoDown)} ${ui.name}", Modifier.size(24.dp).tag(DeckTags.TEMPO_DOWN), glyph = Glyph.Minus, kind = BtnKind.Cell) {
            ui.ctl.setTempoFader(ui.index, ui.c.tempoFader - step)
        }
        FlatFader(
            "${str(Str.Tempo)} ${ui.name}", text, ui.c.tempoFader, -1f..1f, 0f, Modifier.weight(1f).fillMaxHeight().tag(DeckTags.TEMPO),
            look = FaderLook.Tempo, color = DecksColors.deck(ui.index), detent = 0f, step = step,
        ) { ui.ctl.setTempoFader(ui.index, it) }
        OnButton(null, "${str(Str.TempoUp)} ${ui.name}", Modifier.size(24.dp).tag(DeckTags.TEMPO_UP), glyph = Glyph.Plus, kind = BtnKind.Cell) {
            ui.ctl.setTempoFader(ui.index, ui.c.tempoFader + step)
        }
        OnButton(
            "\u00B1$rangePct", "${str(Str.TempoRange, rangePct)} ${ui.name}", Modifier.width(34.dp).height(24.dp).tag(DeckTags.TEMPO_RANGE),
            kind = BtnKind.Cell, padH = 0.dp,
        ) { ui.ctl.cycleTempoRange(ui.index) }
        OnButton(
            text, "${str(Str.TempoReset)} ${ui.name}", Modifier.width(52.dp).height(24.dp).tag(DeckTags.TEMPO_RESET),
            kind = BtnKind.Cell, padH = 0.dp, state = text,
        ) { ui.ctl.resetTempo(ui.index) }
    }
}

/** −  +1.2%  + : tempo as a small numeric control (compact tier). Activating the value resets it. */
@Composable
private fun TempoStepper(ui: DeckUi) {
    val text = ui.v.tempoText
    val step = (0.001 / ui.c.tempoRange).toFloat()
    Row(Modifier.fillMaxHeight(), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        OnButton(
            null, "${str(Str.TempoDown)} ${ui.name}", Modifier.width(24.dp).fillMaxHeight().tag(DeckTags.TEMPO_DOWN),
            glyph = Glyph.Minus, kind = BtnKind.Cell,
        ) { ui.ctl.setTempoFader(ui.index, ui.c.tempoFader - step) }
        OnButton(
            text, "${str(Str.TempoReset)} ${ui.name}", Modifier.width(52.dp).fillMaxHeight().tag(DeckTags.TEMPO_RESET),
            kind = BtnKind.Cell, padH = 0.dp, state = text,
        ) { ui.ctl.resetTempo(ui.index) }
        OnButton(
            null, "${str(Str.TempoUp)} ${ui.name}", Modifier.width(24.dp).fillMaxHeight().tag(DeckTags.TEMPO_UP),
            glyph = Glyph.Plus, kind = BtnKind.Cell,
        ) { ui.ctl.setTempoFader(ui.index, ui.c.tempoFader + step) }
    }
}

/* ── tabs, pads, loops ────────────────────────────────────────────────── */

/** HOT CUE · LOOP; the delete-cues toggle sits at the end of the row while the pads show. */
@Composable
private fun TabRow(ui: DeckUi) {
    val del = ui.c.hotCueDeleteMode
    val delText = "${str(Str.HotCueDelete)} ${ui.name}"
    val delState = str(if (del) Str.On else Str.Off)
    TierTabs(
        listOf(str(Str.TabCues), str(Str.TabLoops)), if (ui.tab.value == DeckTab.Cues) 0 else 1,
        tags = listOf(DeckTags.TAB_CUES, DeckTags.TAB_LOOPS),
        trailing = {
            if (ui.tab.value == DeckTab.Cues) {
                OnButton(null, delText, Modifier.size(24.dp).tag(DeckTags.CUE_DELETE), on = del, glyph = Glyph.Eraser, accent = DecksColors.alert, state = delState) {
                    ui.ctl.toggleHotCueDelete(ui.index)
                }
            }
        },
    ) { ui.tab.value = if (it == 0) DeckTab.Cues else DeckTab.Loops }
}

@Composable
private fun TabBody(ui: DeckUi, tab: DeckTab, modifier: Modifier) {
    when (tab) {
        DeckTab.Cues -> HotCuePads(ui, 2, modifier)
        DeckTab.Loops -> Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            LoopSizes(ui, Modifier.weight(1f).fillMaxWidth())
            LoopRow(ui, short = false)
        }
    }
}

/** Pad width (dp) from which a set pad also shows its cue time. */
private const val PAD_TIME_MIN_W = 56

/** [rows] × 4 hot cue pads: the pad number, the cue time when set (and the pad is wide enough), the cue colour as a 4 dp bar; empty = dashed. */
@Composable
private fun HotCuePads(ui: DeckUi, rows: Int, modifier: Modifier) {
    Recomposed(DeckProbe.PADS)
    BoxWithConstraints(modifier) {
        val times = maxWidth >= (4 * PAD_TIME_MIN_W + 3 * 4).dp
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (r in 0 until rows) {
                Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (col in 0 until 4) {
                        val slot = r * 4 + col
                        val at = ui.v.hotCues.getOrNull(slot)
                        CuePad(
                            "${slot + 1}", if (times) at?.let { splitTime(it).first } else null,
                            str(if (at != null) Str.HotCue else Str.HotCueEmpty, slot + 1) + " ${ui.name}", at != null, DecksColors.cue(slot),
                            Modifier.weight(1f).fillMaxHeight().tag(DeckTags.pad(slot)), enabled = ui.v.loaded,
                        ) { ui.ctl.hotCue(ui.index, slot) }
                    }
                }
            }
        }
    }
}

/** Loop size cells (¼ … 32 beats): the outlined one is the size LOOP uses. */
@Composable
private fun LoopSizes(ui: DeckUi, modifier: Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        for (beats in DeckMath.LOOP_SIZES) {
            val label = DeckMath.loopLabel(beats)
            val on = sameBeats(ui.c.loopBeats, beats)
            OnButton(
                label, str(Str.Loop, label), Modifier.weight(1f).fillMaxHeight().tag(DeckTags.loopSize(beats)), on = on, kind = BtnKind.Cell, padH = 1.dp,
                state = str(if (on) Str.On else Str.Off),
            ) { ui.c.loopBeats = beats }
        }
    }
}

/** LOOP n (lit and reading EXIT while a loop runs), ½, 2×, and IN / OUT unless [short]. */
@Composable
private fun LoopRow(ui: DeckUi, short: Boolean) {
    val size = DeckMath.loopLabel(ui.c.loopBeats)
    val active = ui.v.loopActive
    val loaded = ui.v.loaded
    Row(Modifier.height(24.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        OnButton(
            if (active) str(Str.LoopExitShort) else "${str(Str.TabLoops).uppercase()} $size",
            (if (active) str(Str.LoopExit) else str(Str.Loop, size)) + " ${ui.name}", Modifier.weight(1f).fillMaxHeight().tag(DeckTags.LOOP),
            on = active, enabled = loaded, state = str(if (active) Str.On else Str.Off), padH = 4.dp,
        ) { ui.ctl.loopAuto(ui.index) }
        OnButton(
            "\u00BD", "${str(Str.LoopHalve)} ${ui.name}", Modifier.size(24.dp).tag(DeckTags.LOOP_HALVE),
            kind = BtnKind.Cell, enabled = loaded, padH = 0.dp,
        ) { ui.ctl.loopHalve(ui.index) }
        OnButton(
            "2\u00D7", "${str(Str.LoopDouble)} ${ui.name}", Modifier.size(24.dp).tag(DeckTags.LOOP_DOUBLE),
            kind = BtnKind.Cell, enabled = loaded, padH = 0.dp,
        ) { ui.ctl.loopDouble(ui.index) }
        if (!short) {
            OnButton(
                str(Str.LoopInShort), "${str(Str.LoopIn)} ${ui.name}", Modifier.fillMaxHeight().tag(DeckTags.LOOP_IN),
                enabled = loaded, padH = 6.dp,
            ) { ui.ctl.loopIn(ui.index) }
            OnButton(
                str(Str.LoopOutShort), "${str(Str.LoopOut)} ${ui.name}", Modifier.fillMaxHeight().tag(DeckTags.LOOP_OUT),
                enabled = loaded, padH = 6.dp,
            ) { ui.ctl.loopOut(ui.index) }
        }
    }
}

/* ── MORE ─────────────────────────────────────────────────────────────── */

/**
 * MORE: everything the box has no room for, in a popup over the deck: what the header lost (key chip,
 * MASTER, the BPM of a box under the icon minimum), SYNC when the transport row has none, sync lock,
 * Q, SLIP, KEY lock, nudge, key shift / match, beat jump, the tempo fader, the seek strip when the
 * panel shows only a progress line, and the tabs with all eight pads when they are not inline. A sheet
 * opened from the header also starts with a CUE and a PLAY ([SheetTransport]).
 */
@Composable
private fun MoreButton(ui: DeckUi) {
    val open = ui.more
    val label = "${str(Str.MoreControls)} ${ui.name}"
    Box(Modifier.fillMaxHeight().width(24.dp)) {
        OnButton(
            null, label, Modifier.fillMaxSize().tag(DeckTags.MORE), on = open.value, glyph = Glyph.More,
            state = str(if (open.value) Str.On else Str.Off),
        ) { open.value = !open.value }
        if (open.value) MoreSheet(ui, label)
    }
}

/** Controls of the sheet that stay together: on a narrow window the groups wrap as units, a group is never split or squeezed. */
@Composable
private fun SheetGroup(content: @Composable RowScope.() -> Unit) {
    Row(Modifier.height(24.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically, content = content)
}

/** Widths (dp) of CUE and PLAY in the MORE sheet (the full deck's own), and their height with a pointer / on touch input. */
const val SHEET_CUE_W = 56
const val SHEET_PLAY_W = 88
const val SHEET_TRANSPORT_H = 32
const val SHEET_TRANSPORT_TOUCH_H = 48

/**
 * CUE and PLAY inside the MORE sheet. The sheet of a deck whose MORE is in the header (the icon tier) opens over
 * that deck's own transport row, and a tap outside the sheet only closes it: without these two, stopping the deck
 * took two taps. They are the panel's own buttons (same controller calls, same names and states, same test tags),
 * 148 dp wide together, so they fit the 288 dp of controls a 320 dp window leaves.
 */
@Composable
private fun SheetTransport(ui: DeckUi) {
    val h = if (LocalTouchInput.current) SHEET_TRANSPORT_TOUCH_H else SHEET_TRANSPORT_H
    Row(Modifier.height(h.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        CueButton(ui, Modifier.width(SHEET_CUE_W.dp).fillMaxHeight())
        PlayButton(ui, Modifier.width(SHEET_PLAY_W.dp).fillMaxHeight(), word = true)
    }
}

/**
 * Width (dp) of the sheet from which beat jump and the tempo fader share one row: jump 82 + gap 10 + the tempo
 * line's fixed cells 142 + a fader of at least 66. Narrower (a 320 dp phone: 288 dp of sheet) they take two rows.
 */
const val SHEET_TEMPO_ROW_MIN_W = 300

/**
 * The sheet is as wide as [MorePopup] makes it: 400 dp of controls on a desktop window, the window minus a margin
 * on a phone (360 dp wide: 328 dp of controls). The first row is a flow of groups that wrap; the popup scrolls when
 * the sheet is higher than the window.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MoreSheet(ui: DeckUi, label: String) {
    val open = ui.more
    val f = ui.fit
    MorePopup(onDismiss = { open.value = false }) {
        Column(Modifier.fillMaxWidth().tag(DeckTags.SHEET).semantics { contentDescription = label }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FlowRow(
                Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                // First: the transport the open sheet covers (MORE in the header = the sheet opens over CUE / PLAY).
                if (f.moreInHeader) SheetTransport(ui)
                SheetGroup {
                    DeckBadge(ui, 18.dp)
                    if (!f.keyChip) DeckKeyChip(ui, shift = true)
                    if (!f.twoRowHeader) MasterBadge(ui)
                    if (!f.readoutRow && f.moreInHeader && !f.headerBpm) BpmValue(ui, 15f)
                }
                SheetGroup {
                    if (!f.sync) SyncButton(ui)
                    SyncLockButton(ui)
                    ModeToggles(ui)
                    KeyLockButton(ui)
                }
                SheetGroup { NudgeCells(ui) }
                SheetGroup { KeyControls(ui) }
            }
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val oneRow = maxWidth >= SHEET_TEMPO_ROW_MIN_W.dp
                if (oneRow) {
                    Row(Modifier.height(24.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        BeatJump(ui)
                        TempoFader(ui, Modifier.weight(1f), label = false)
                    }
                } else {
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        BeatJump(ui)
                        TempoFader(ui, Modifier.fillMaxWidth(), label = false)
                    }
                }
            }
            // The smallest icon box shows a progress line only: the strip that seeks is here.
            if (f.waveH == 0) OverviewStrip(ui, Modifier.fillMaxWidth().height(32.dp))
            if (!f.tabs) {
                TabRow(ui)
                TabBody(ui, ui.tab.value, Modifier.height(64.dp).fillMaxWidth())
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                OnButton(null, str(Str.ImportClose), Modifier.size(24.dp).tag(DeckTags.CLOSE), glyph = Glyph.Close) { open.value = false }
            }
        }
    }
}
