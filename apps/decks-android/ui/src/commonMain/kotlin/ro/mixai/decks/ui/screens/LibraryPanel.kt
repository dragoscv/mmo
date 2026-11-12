package ro.mixai.decks.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CollectionInfo
import androidx.compose.ui.semantics.CollectionItemInfo
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.collectionInfo
import androidx.compose.ui.semantics.collectionItemInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.Glyph
import ro.mixai.decks.ui.components.GlyphIcon
import ro.mixai.decks.ui.components.KeyChip
import ro.mixai.decks.ui.components.LookLine
import ro.mixai.decks.ui.components.LookText
import ro.mixai.decks.ui.components.MicroLabel
import ro.mixai.decks.ui.components.OnButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.components.activatable
import ro.mixai.decks.ui.components.inkOn
import ro.mixai.decks.ui.components.isDpadCenter
import ro.mixai.decks.ui.components.needs
import ro.mixai.decks.ui.components.tag
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.i18n.Counted
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.i18n.strCount
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.model.TrackRow
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksSkin
import ro.mixai.decks.ui.theme.LocalTouchInput
import ro.mixai.decks.ui.theme.Oklab
import ro.mixai.decks.ui.theme.controlShape

/*
 * Library panel, "MixAI Signature" (Decks 1.5): the Compose mirror of apps/mixai/src/library
 * (LibraryRows.tsx + library.css). A dense table: a 28 dp toolbar (crate, search, count, scan, load
 * to A / B), a 20 dp column header and 22 dp zebra rows with aligned columns: status, title, artist,
 * BPM, key chip (Camelot colour), time, load. Rows of tracks that were on air are dimmed and marked;
 * a track that sits on a deck carries that deck's letter.
 *
 * Zero scroll: there is no scrolling container and no scroll bar. The panel draws the whole rows
 * that fit from a window that follows the selection (`windowFor`); the wheel and a vertical drag move
 * the window, Up / Down / Page / Home / End move the selection (D-pad too), and a thin position mark
 * shows where the window is. HOW MANY rows fit is `libraryRows` (PanelFit.kt, pure and unit-tested),
 * called once in [LibraryPanel] for the list and the crate column: neither measures rows by itself
 * (desktopTest LibraryAccessTest counts the rendered rows against the same function).
 *
 * Keyboard: the list is ONE focus stop; the arrows move the selection inside it (the screen's
 * shortcut map uses Up / Down for the library everywhere, so the rows are not focus stops of their
 * own). Enter / D-pad centre loads the selected row on deck A, Shift+Enter on deck B. A key pressed
 * with Ctrl, Alt or Meta is not the list's: it goes on to the screen's shortcuts (Ctrl+Enter plays
 * deck B, Ctrl+Left / Right load the selected row).
 * Assistive tech: each row is a node with its position in the list, its selected state, "played" /
 * "on Deck A" as state, and two custom actions (load on deck A / B).
 *
 * Target size (WCAG 2.5.8). With a pointer the rows are 22 dp, so the A / B load cells inside them
 * are 24×18 dp, under the 24 dp minimum; they are pointer-only (not tab stops) and each has a 24 dp,
 * keyboard-reachable equivalent: the A / B buttons of the toolbar (they load the selected row) and
 * Enter / Shift+Enter on the list. On touch input ([LocalTouchInput]: a device with a touch screen)
 * the rows are 48 dp high and the load cells 48×48 dp.
 */

/** Width (dp) from which the full tier shows the crate list as a column instead of the toolbar stepper. */
private const val CRATE_COLUMN_MIN_W = 900

/** Test names of the library's controls ([tag]): not spoken, not shown. */
object LibraryTags {
    const val CRATE_PREV = "library-crate-prev"
    const val CRATE_NEXT = "library-crate-next"
    const val SEARCH = "library-search"
    const val SCAN = "library-scan"
    const val LOAD_A = "library-load-a"
    const val LOAD_B = "library-load-b"
    const val LIST = "library-list"

    /** One per crate of the crate column (full tier from 900 dp wide: it replaces the two crate steps). */
    const val CRATE = "library-crate"

    /** One per visible row, and the two load cells of a row (tiers with a load column). */
    const val ROW = "library-row"
    const val ROW_LOAD_A = "library-row-load-a"
    const val ROW_LOAD_B = "library-row-load-b"

    /** Every control of the full library (the crate column of a 900 dp wide panel replaces the two crate steps). */
    val CONTROLS: List<String> = listOf(CRATE_PREV, CRATE_NEXT, SEARCH, SCAN, LOAD_A, LOAD_B, LIST)
}

/** Tracks that were on air for 30 s; fed once a second while the panel is on screen. */
private class Played(initial: Set<String>) {
    var ids by mutableStateOf(initial)
    val log = PlayedLog { id -> ids = ids + id }
}

/**
 * The visible window of the list. It follows the selection and is moved freely by the wheel / a
 * drag. The window position is plain data written while composing ([sync]); only [moves] is state,
 * so a wheel notch recomposes the list and composing never writes state it has read.
 */
private class ListWindow {
    private var first = 0
    private var pending = 0
    private var seenSelected = -1
    private var seenList: Any? = null
    private var moves by mutableStateOf(0)

    /** First row to draw for [visible] rows of [total], selection at [selected]; [list] = identity of the result list. */
    fun sync(visible: Int, total: Int, selected: Int, list: Any): Int {
        moves // subscribe: wheel and drag bump it
        var f = (first + pending).coerceIn(0, maxOf(0, total - visible))
        pending = 0
        if (list !== seenList || selected != seenSelected) f = windowFor(f, visible, total, selected)
        seenList = list
        seenSelected = selected
        first = f
        return f
    }

    fun scrollBy(rows: Int) {
        if (rows == 0) return
        pending += rows
        moves++
    }
}

/** Column geometry of the table. [touch] = touch input: 48 dp rows and 48 dp load cells instead of the dense ones. */
private class Cols(val tier: PanelTier, val touch: Boolean) {
    val rowDp: Int get() = libRowDp(touch)
    val pad: Dp get() = when (tier) { PanelTier.Full -> 8.dp; PanelTier.Compact -> 6.dp; PanelTier.Icon -> 4.dp }
    val gap: Dp get() = when (tier) { PanelTier.Full -> 8.dp; PanelTier.Compact -> 6.dp; PanelTier.Icon -> 4.dp }
    val status: Dp get() = if (tier == PanelTier.Icon) 16.dp else 18.dp
    val artist: Boolean get() = tier == PanelTier.Full
    val bpm: Dp? get() = when (tier) { PanelTier.Full -> 48.dp; PanelTier.Compact -> 28.dp; PanelTier.Icon -> null }
    val key: Dp get() = 38.dp
    val time: Dp? get() = if (tier == PanelTier.Full) 36.dp else null

    /** Two load cells and their 2 dp gap: 24 dp cells with a pointer, 48 dp on touch. */
    val load: Dp? get() = if (tier == PanelTier.Icon) null else if (touch) 98.dp else 50.dp
}

/**
 * Library: search, crates, scan a folder (platform picker via [onScanFolder]), load to A / B.
 * [tier] = the solver's tier (`PANEL_SPECS`: full from 520×240, compact from 320×160, icon from 200×96 dp).
 * [initialPlayed] = track ids shown as already played when the panel opens (previews and tests).
 * [touch] = touch input ([LocalTouchInput]): rows and load cells get 48 dp targets.
 */
@Composable
fun LibraryPanel(
    ctl: DecksController,
    onScanFolder: (() -> Unit)?,
    modifier: Modifier = Modifier,
    tier: PanelTier = PanelTier.Full,
    initialPlayed: Set<String> = emptySet(),
    touch: Boolean = LocalTouchInput.current,
) {
    val label = str(Str.Library)
    val played = remember(ctl) { Played(initialPlayed) }
    LaunchedEffect(ctl, played) {
        while (true) {
            delay(1000)
            played.log.sample(1.0, ctl.engine.decks.map { d -> if (d.playing) ctl.deckRow(d.index)?.id else null })
        }
    }
    val window = remember(ctl) { ListWindow() }
    val lag = remember { FitLag() }
    BoxWithConstraints(modifier) {
        // The width thresholds (crate name, status area, crate column) and the tier get the same dead band as the decks.
        val boxW = maxWidth.value.toDouble()
        val boxH = maxHeight.value.toDouble()
        val box = remember(lag, tier, boxW, boxH) { lag.settle(PanelId.Library, tier, boxW, boxH) }
        val w = box.w
        val t = box.tier
        val cols = remember(t, touch) { Cols(t, touch) }
        // The one row count of the panel: whole rows that fit the real height under the toolbar and the column header
        // of the tier in use (a row more or less is not an arrangement: it needs no dead band).
        val rows = libraryRows(t, boxH, cols.rowDp)
        val crateColumn = t == PanelTier.Full && w >= CRATE_COLUMN_MIN_W
        val line = DecksColors.border
        Panel(Modifier.fillMaxSize().semantics { contentDescription = label }, verticalPad = 0.dp, horizontalPad = 0.dp) {
            Column(Modifier.fillMaxSize()) {
                Toolbar(ctl, onScanFolder, t, w, crateColumn)
                Row(Modifier.weight(1f).fillMaxWidth()) {
                    if (crateColumn) {
                        CrateColumn(ctl, cols.rowDp, rows, Modifier.width(150.dp).fillMaxHeight().drawBehind {
                            drawRect(line, Offset(size.width - 1.dp.toPx(), 0f), Size(1.dp.toPx(), size.height))
                        })
                    }
                    Column(Modifier.weight(1f).fillMaxHeight()) {
                        if (t != PanelTier.Icon) HeaderRow(cols)
                        TrackList(ctl, cols, rows, played.ids, window, Modifier.weight(1f).fillMaxWidth())
                    }
                }
            }
        }
    }
}

/* ── toolbar ──────────────────────────────────────────────────────────── */

private fun crateIds(ctl: DecksController): List<Long?> = listOf<Long?>(null) + ctl.crates.filter { !it.isFolder }.map { it.id }

@Composable
private fun crateName(ctl: DecksController): String =
    ctl.selectedCrate?.let { id -> ctl.crates.firstOrNull { it.id == id }?.name } ?: str(Str.AllTracks)

/**
 * Crate (◀ name ▶), search, track count and scan status (roomy panels), scan, load A / B. Every tier has every
 * control: the icon tier (200 dp wide: 4 + 50 + 4 + 56 + 4 + 24 + 4 + 50 + 4) drops the crate name and the words
 * (the crate in use is always spoken by the two arrows).
 */
@Composable
private fun Toolbar(ctl: DecksController, onScanFolder: (() -> Unit)?, tier: PanelTier, w: Double, crateColumn: Boolean) {
    val line = DecksColors.border
    val icon = tier == PanelTier.Icon
    val pad = if (icon) 4.dp else 8.dp
    val gap = if (icon) 4.dp else 6.dp
    val selected = ctl.results.getOrNull(ctl.selectedRow)
    val crate = crateName(ctl)
    Row(
        Modifier.height(libToolbarDp(tier).dp).fillMaxWidth()
            .drawBehind { drawRect(line, Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx())) }
            .padding(start = pad, end = pad, bottom = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!crateColumn) {
            // Crate stepper: ◀ name ▶ (the name gives way on a narrow panel; it is always spoken).
            val ids = crateIds(ctl)
            val at = ids.indexOf(ctl.selectedCrate).coerceAtLeast(0)
            Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
                OnButton(null, "${str(Str.CratePrev)}: $crate", Modifier.size(24.dp).tag(LibraryTags.CRATE_PREV), glyph = Glyph.Left, enabled = ids.size > 1) {
                    ctl.selectCrate(ids[(at - 1).mod(ids.size)])
                }
                // From the full tier's minimum width (520 dp) the crate in use is on screen, not only spoken.
                if (!icon && w >= 520) {
                    LookLine(crate, LookText.style(11f, DecksColors.foreground, FontWeight.SemiBold, line = 14f), Modifier.width(96.dp).padding(horizontal = 4.dp), fit = false)
                }
                OnButton(null, "${str(Str.CrateNext)}: $crate", Modifier.size(24.dp).tag(LibraryTags.CRATE_NEXT), glyph = Glyph.Right, enabled = ids.size > 1) {
                    ctl.selectCrate(ids[(at + 1).mod(ids.size)])
                }
            }
        }
        // One flexible item per row: the search box on a narrow panel, the status area on a roomy one.
        val roomy = tier == PanelTier.Full && w >= 760
        SearchField(ctl, if (roomy) Modifier.width(280.dp) else Modifier.weight(1f), short = icon)
        if (roomy) {
            LookLine(strCount(Counted.TrackCount, ctl.results.size), LookText.style(11f, DecksColors.muted, FontWeight.Medium, line = 14f, tabular = true))
            Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.CenterEnd) {
                ctl.scan?.let { s ->
                    val text = when {
                        s.failed -> s.error ?: "error"
                        s.finished -> str(Str.ScanDone, s.added)
                        else -> str(Str.Scanning, s.done, s.total)
                    }
                    LookLine(text, LookText.style(11f, DecksColors.muted, line = 14f), fit = false)
                }
            }
        }
        if (onScanFolder != null) {
            // The word on the full tier; a 24 dp glyph button (named for assistive tech) below it.
            OnButton(
                if (tier == PanelTier.Full) str(Str.ScanFolder).uppercase() else null, str(Str.ScanFolder),
                Modifier.height(24.dp).tag(LibraryTags.SCAN), glyph = Glyph.Plus, padH = 6.dp,
            ) { onScanFolder() }
        }
        // 24 dp load buttons for the selected row (the cells inside the 22 dp rows are smaller).
        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            for (deck in 0..1) {
                val name = str(if (deck == 0) Str.LoadToA else Str.LoadToB)
                OnButton(
                    if (deck == 0) "A" else "B", if (selected != null) "$name: ${selected.title}" else name,
                    Modifier.size(24.dp).tag(if (deck == 0) LibraryTags.LOAD_A else LibraryTags.LOAD_B),
                    enabled = selected != null, glyph = null, tint = DecksColors.deck(deck), padH = 0.dp,
                ) { ctl.loadSelected(deck) }
            }
        }
    }
}

/** Search box: a 24 dp well with a hairline; the focus ring replaces the hairline. [short] = a one-word placeholder (the spoken name stays the full hint). */
@Composable
private fun SearchField(ctl: DecksController, modifier: Modifier, short: Boolean) {
    val hint = str(Str.Search)
    val placeholder = if (short) str(Str.SearchShort) else hint
    var focused by remember { mutableStateOf(false) }
    val shape = controlShape(LocalDecksSkin.current)
    Box(
        modifier.height(24.dp)
            .needs(hint, 48.dp, 24.dp)
            .tag(LibraryTags.SEARCH)
            .background(DecksColors.well, shape)
            .border(if (focused) 2.dp else 1.dp, if (focused) DecksColors.ring else DecksColors.border, shape)
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        // The placeholder of the icon tier must show whole; the long one may end in an ellipsis on a narrow panel.
        if (ctl.query.isEmpty()) LookLine(placeholder, LookText.style(11f, DecksColors.faint, line = 14f), fit = short)
        BasicTextField(
            ctl.query, { ctl.search(it) },
            Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused }.semantics { contentDescription = hint },
            textStyle = LookText.style(11f, DecksColors.foreground, line = 14f), singleLine = true, cursorBrush = SolidColor(DecksColors.ring),
        )
    }
}

/* ── crate column (wide full tier) ────────────────────────────────────── */

/** [rows] = how many crates show: the panel's row count (the column has a head as high as the table's header). */
@Composable
private fun CrateColumn(ctl: DecksController, rowDp: Int, rows: Int, modifier: Modifier) {
    val line = DecksColors.border
    val ids = crateIds(ctl)
    Box(modifier) {
        val at = ids.indexOf(ctl.selectedCrate).coerceAtLeast(0)
        val first = windowFor(0, rows, ids.size, at)
        Column(Modifier.fillMaxSize()) {
            Box(
                Modifier.height(LIB_HEAD_DP.dp).fillMaxWidth()
                    .drawBehind { drawRect(line, Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx())) }
                    .padding(horizontal = 8.dp),
                contentAlignment = Alignment.CenterStart,
            ) { MicroLabel(str(Str.Crates), Modifier.semantics { heading() }) }
            for (i in first until minOf(ids.size, first + rows)) {
                val id = ids[i]
                val name = if (id == null) str(Str.AllTracks) else ctl.crates.firstOrNull { it.id == id }?.name.orEmpty()
                val on = id == ctl.selectedCrate
                val fill = rowFill(on, false)
                val onColor = DecksColors.on
                Box(
                    Modifier.height(rowDp.dp).fillMaxWidth()
                        .background(fill)
                        .drawBehind { if (on) drawRect(onColor, size = Size(2.dp.toPx(), size.height)) }
                        .tag(LibraryTags.CRATE)
                        .activatable(name, selected = on) { ctl.selectCrate(id) }
                        .padding(horizontal = 8.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    LookLine(name, LookText.style(11f, if (on) DecksColors.foreground else DecksColors.muted, if (on) FontWeight.SemiBold else FontWeight.Normal, line = 14f), fit = false)
                }
            }
        }
    }
}

/* ── table ────────────────────────────────────────────────────────────── */

/** Row background: zebra on the panel colour; selected = a stronger fill in the ON colour (plus the 2 dp bar). */
@Composable
private fun rowFill(selected: Boolean, odd: Boolean): Color {
    val card = DecksColors.surface
    val fg = DecksColors.foreground
    val on = DecksColors.on
    return remember(card, fg, on, selected, odd) {
        when {
            selected -> Oklab.mix(on, card, 0.18f)
            odd -> Oklab.mix(fg, card, 0.03f)
            else -> card
        }
    }
}

/** The cells of one table line; the header and every row use it, so the columns line up at any width. */
@Composable
private fun TableLine(
    cols: Cols,
    status: @Composable () -> Unit,
    title: @Composable RowScope.() -> Unit,
    bpm: @Composable () -> Unit,
    key: @Composable () -> Unit,
    time: @Composable () -> Unit,
    load: @Composable () -> Unit,
) {
    Row(
        Modifier.fillMaxSize().padding(start = cols.pad, end = cols.pad + 10.dp),
        horizontalArrangement = Arrangement.spacedBy(cols.gap), verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(cols.status), contentAlignment = Alignment.Center) { status() }
        title()
        cols.bpm?.let { Box(Modifier.width(it), contentAlignment = Alignment.CenterEnd) { bpm() } }
        Box(Modifier.width(cols.key), contentAlignment = Alignment.CenterStart) { key() }
        cols.time?.let { Box(Modifier.width(it), contentAlignment = Alignment.CenterEnd) { time() } }
        cols.load?.let { Box(Modifier.width(it), contentAlignment = Alignment.CenterEnd) { load() } }
    }
}

@Composable
private fun HeaderRow(cols: Cols) {
    val line = DecksColors.border
    Box(
        Modifier.height(LIB_HEAD_DP.dp).fillMaxWidth()
            .drawBehind { drawRect(line, Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx())) }
            .padding(bottom = 1.dp),
    ) {
        TableLine(
            cols,
            status = {},
            title = {
                MicroLabel(str(Str.ColTitle), Modifier.weight(3f))
                if (cols.artist) MicroLabel(str(Str.ColArtist), Modifier.weight(2f))
            },
            bpm = { MicroLabel(str(Str.Bpm)) },
            key = { MicroLabel(str(Str.KeyShort)) },
            time = { MicroLabel(str(Str.ColTime)) },
            load = {},
        )
    }
}

/** A deck letter on a dot in the deck colour: "this track is on that deck" (a letter, not colour only). */
@Composable
private fun DeckDot(deck: Int) {
    val color = DecksColors.deck(deck)
    Box(Modifier.size(14.dp).background(color, CircleShape), contentAlignment = Alignment.Center) {
        LookLine(if (deck == 0) "A" else "B", LookText.style(9f, inkOn(color), FontWeight.ExtraBold, line = 10f))
    }
}

/**
 * A / B load cell inside a row: 24×18 dp in a dense 22 dp row (pointer only, see the target-size note at the top
 * of the file), 48×48 dp on touch (the mark stays small, the target is the whole cell).
 */
@Composable
private fun LoadCell(deck: Int, description: String, touch: Boolean, onClick: () -> Unit) {
    val click by rememberUpdatedState(onClick)
    val shape = controlShape(LocalDecksSkin.current)
    val raised = DecksColors.surfaceRaised
    val edge = DecksColors.border
    Box(
        (if (touch) Modifier.size(LIB_ROW_TOUCH_DP.dp) else Modifier.size(width = 24.dp, height = 18.dp))
            .tag(if (deck == 0) LibraryTags.ROW_LOAD_A else LibraryTags.ROW_LOAD_B)
            .pointerInput(Unit) { detectTapGestures { click() } }
            // Its own node: the row merges its descendants, and this is a separate action of the row.
            .semantics(mergeDescendants = true) {
                contentDescription = description
                role = Role.Button
                onClick(label = description) { click(); true }
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.size(width = if (touch) 32.dp else 24.dp, height = if (touch) 28.dp else 18.dp).background(raised, shape).border(1.dp, edge, shape),
            contentAlignment = Alignment.Center,
        ) {
            LookLine(if (deck == 0) "A" else "B", LookText.style(10f, DecksColors.deck(deck), FontWeight.ExtraBold, line = 12f))
        }
    }
}

/**
 * The visible window of the list: [visible] rows (the panel's row count, `libraryRows`) from the row the
 * [ListWindow] is at. The list does not measure how many rows fit.
 */
@Composable
private fun TrackList(ctl: DecksController, cols: Cols, visible: Int, played: Set<String>, window: ListWindow, modifier: Modifier) {
    val results = ctl.results
    val total = results.size
    var focused by remember { mutableStateOf(false) }
    val label = str(Str.Library)
    // Which track sits on which deck (re-read when a load starts or finishes).
    val onDeck = (0..1).map { i ->
        val c = ctl.controls[i]
        if (c.loadPhase == null && c.meta == null && c.peaks == null) null else ctl.deckRow(i)?.id
    }
    val rowDp = cols.rowDp
    if (total == 0) {
        Box(modifier.clipToBounds().padding(horizontal = 8.dp, vertical = 4.dp), contentAlignment = Alignment.Center) {
            BasicText(str(Str.NoTracks), style = LookText.style(12f, DecksColors.muted, line = 16f), maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        return
    }
    Box(modifier.clipToBounds()) {
        val first = window.sync(visible, total, ctl.selectedRow, results)
        val rowPx = with(LocalDensity.current) { rowDp.dp.toPx() }
        val vis by rememberUpdatedState(visible)
        val count by rememberUpdatedState(total)
        Column(
            Modifier.fillMaxSize()
                .onFocusChanged { focused = it.isFocused }
                .onKeyEvent { e ->
                    if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
                    // A chord with Ctrl, Alt or Meta is a shortcut of the screen (Ctrl+Enter plays deck B, Ctrl+Left / Right
                    // load the selected row): not consumed here, so it bubbles. Shift stays: Shift+Enter loads on deck B.
                    if (e.isCtrlPressed || e.isAltPressed || e.isMetaPressed) return@onKeyEvent false
                    when (e.key) {
                        Key.DirectionUp -> ctl.moveSelection(-1)
                        Key.DirectionDown -> ctl.moveSelection(1)
                        Key.PageUp -> ctl.moveSelection(-maxOf(1, vis))
                        Key.PageDown -> ctl.moveSelection(maxOf(1, vis))
                        Key.MoveHome -> ctl.moveSelection(-count)
                        Key.MoveEnd -> ctl.moveSelection(count)
                        Key.Enter, Key.NumPadEnter -> ctl.loadSelected(if (e.isShiftPressed) 1 else 0)
                        else -> if (isDpadCenter(e.key)) ctl.loadSelected(0) else return@onKeyEvent false
                    }
                    true
                }
                .focusable()
                // Wheel (three rows a notch) and vertical drag (touch) move the window; nothing scrolls by pixels.
                .pointerInput(Unit) {
                    awaitPointerEventScope {
                        while (true) {
                            val e = awaitPointerEvent()
                            if (e.type != PointerEventType.Scroll) continue
                            val dy = e.changes.firstOrNull()?.scrollDelta?.y ?: 0f
                            if (dy != 0f) {
                                val rows = (dy * 3).roundToInt().let { if (it == 0) (if (dy > 0) 1 else -1) else it }
                                window.scrollBy(rows)
                                e.changes.forEach { it.consume() }
                            }
                        }
                    }
                }
                .pointerInput(rowPx) {
                    var acc = 0f
                    detectVerticalDragGestures(onDragStart = { acc = 0f }) { change, dy ->
                        change.consume()
                        acc -= dy
                        val rows = (acc / rowPx).toInt()
                        if (rows != 0) {
                            window.scrollBy(rows)
                            acc -= rows * rowPx
                        }
                    }
                }
                .tag(LibraryTags.LIST)
                .semantics {
                    contentDescription = label
                    collectionInfo = CollectionInfo(total, 1)
                },
        ) {
            for (i in first until minOf(total, first + visible)) {
                val r = results[i]
                TrackLine(ctl, cols, r, i, i == ctl.selectedRow, focused, r.id in played, onDeck.indices.filter { onDeck[it] == r.id })
            }
        }
        // Position mark: where the window sits in the list. Not a scroll bar: no rail, no thumb to grab, no input;
        // a 2 dp line at the panel edge as long as the visible share of the list.
        if (total > visible && visible > 0) {
            val mark = Oklab.mix(DecksColors.foreground, DecksColors.surface, 0.38f)
            Canvas(Modifier.align(Alignment.CenterEnd).width(4.dp).fillMaxHeight()) {
                val th = maxOf(16.dp.toPx(), size.height * visible / total)
                val y = (size.height - th) * first / (total - visible)
                drawRect(mark, Offset(1.dp.toPx(), y), Size(2.dp.toPx(), th))
            }
        }
    }
}

@Composable
private fun TrackLine(ctl: DecksController, cols: Cols, r: TrackRow, index: Int, selected: Boolean, listFocused: Boolean, played: Boolean, decks: List<Int>) {
    val fill = rowFill(selected, index % 2 == 1)
    val on = DecksColors.on
    val ring = DecksColors.ring
    val artist = r.artist.orEmpty()
    val titleColor = if (played) (if (selected) DecksColors.muted else DecksColors.faint) else DecksColors.foreground
    val dim = if (played) titleColor else DecksColors.muted
    val time = r.durationSec?.let { Format.time(it).substringBefore('.') }.orEmpty()
    val playedWord = str(Str.TrackPlayed)
    val onDeckWords = decks.map { d -> str(Str.TrackOnDeck, str(if (d == 0) Str.DeckA else Str.DeckB)) }
    val state = (listOfNotNull(playedWord.takeIf { played }) + onDeckWords).joinToString(", ")
    val spoken = listOf(r.title, artist, Format.bpm(r.bpm), r.key.orEmpty(), time).filter { it.isNotBlank() }.joinToString(", ")
    val loadA = str(Str.LoadToA)
    val loadB = str(Str.LoadToB)
    val artistSize = LookText.sp(11f)
    Box(
        Modifier.height(cols.rowDp.dp).fillMaxWidth()
            .background(fill)
            .drawBehind {
                if (selected) {
                    drawRect(on, size = Size(2.dp.toPx(), size.height))
                    if (listFocused) {
                        val s = 2.dp.toPx()
                        drawRect(ring, Offset(s / 2, s / 2), Size(size.width - s, size.height - s), style = Stroke(s))
                    }
                }
            }
            .pointerInput(index) { detectTapGestures { ctl.selectedRow = index } }
            .tag(LibraryTags.ROW)
            // One node per row: where it is in the list, whether it is the selected one, what it is doing
            // (played, on a deck), and the two loads as actions of the row (the cells are pointer targets).
            .semantics(mergeDescendants = true) {
                contentDescription = spoken
                this.selected = selected
                collectionItemInfo = CollectionItemInfo(rowIndex = index, rowSpan = 1, columnIndex = 0, columnSpan = 1)
                if (state.isNotEmpty()) stateDescription = state
                onClick { ctl.selectedRow = index; true }
                customActions = listOf(
                    CustomAccessibilityAction(loadA) { ctl.loadToDeck(0, r); true },
                    CustomAccessibilityAction(loadB) { ctl.loadToDeck(1, r); true },
                )
            },
    ) {
        TableLine(
            cols,
            status = {
                when {
                    decks.isNotEmpty() -> DeckDot(decks.first())
                    played -> GlyphIcon(Glyph.Check, DecksColors.faint, size = 11.dp)
                }
            },
            title = {
                if (cols.artist) {
                    LookLine(r.title, LookText.style(12f, titleColor, if (played) FontWeight.Medium else FontWeight.SemiBold, line = 15f), Modifier.weight(3f), fit = false)
                    LookLine(artist, LookText.style(11f, dim, line = 14f), Modifier.weight(2f), fit = false)
                } else {
                    // One cell: the title, then the artist in the muted tone; the line truncates at the end.
                    val text = buildAnnotatedString {
                        append(r.title)
                        if (artist.isNotEmpty() && cols.tier == PanelTier.Compact) {
                            withStyle(SpanStyle(color = dim, fontWeight = FontWeight.Normal, fontSize = artistSize)) { append("  $artist") }
                        }
                    }
                    BasicText(
                        text, Modifier.weight(3f),
                        LookText.style(12f, titleColor, if (played) FontWeight.Medium else FontWeight.SemiBold, line = 15f),
                        overflow = TextOverflow.Ellipsis, softWrap = false, maxLines = 1,
                    )
                }
            },
            bpm = {
                val text = if (cols.tier == PanelTier.Full) Format.bpm(r.bpm) else r.bpm?.takeIf { it > 0 }?.roundToInt()?.toString() ?: "—"
                LookLine(text, LookText.num(11f, if (played) dim else DecksColors.foreground, FontWeight.Medium))
            },
            key = { KeyChip(r.key, Modifier.alpha(if (played) 0.7f else 1f)) },
            time = { LookLine(time, LookText.num(11f, dim, FontWeight.Medium)) },
            load = {
                Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    LoadCell(0, "$loadA: ${r.title}", cols.touch) { ctl.loadToDeck(0, r) }
                    LoadCell(1, "$loadB: ${r.title}", cols.touch) { ctl.loadToDeck(1, r) }
                }
            },
        )
    }
}
