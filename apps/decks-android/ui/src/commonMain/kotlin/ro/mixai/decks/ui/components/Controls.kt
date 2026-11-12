package ro.mixai.decks.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.NonRestartableComposable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.AlignmentLine
import androidx.compose.ui.layout.FirstBaseline
import androidx.compose.ui.layout.LastBaseline
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.LocalDecksSkin
import ro.mixai.decks.ui.theme.LocalDecksType
import ro.mixai.decks.ui.theme.Oklab
import ro.mixai.decks.ui.theme.controlShape
import ro.mixai.decks.ui.theme.panelShape

/** Focus ring shared by every interactive control (keyboard users must see where they are). */
@Composable
private fun Modifier.focusRing(focused: Boolean, shape: Shape): Modifier =
    if (focused) border(2.dp, DecksColors.ring, shape) else this

/**
 * Names a control for the tests (desktopTest/ControlPresenceTest finds every control of a panel in the panel
 * or in its MORE sheet by these names). Not spoken, not shown.
 */
fun Modifier.tag(name: String): Modifier = semantics { testTag = name }

/**
 * Test hook: gets a name every time a marked composable is (re)composed ([Recomposed]) or a marked canvas is
 * redrawn. Null in the apps, where nothing is recorded. desktopTest/RecompositionTest uses it to prove that a
 * moving playhead re-composes the time readouts only, not the deck around them.
 */
val LocalRecomposeProbe = staticCompositionLocalOf<((String) -> Unit)?> { null }

/** Reports one (re)composition of the calling composable to [LocalRecomposeProbe]. Never skipped: it runs whenever its caller does. */
@Composable
@NonRestartableComposable
fun Recomposed(name: String) {
    val probe = LocalRecomposeProbe.current
    if (probe != null) SideEffect { probe(name) }
}

/**
 * The centre key of a D-pad (TV remote, game pad, some hardware keyboards). On a platform that has no such key
 * the constant is the same as [Key.Unknown]: there it must match nothing, or every unmapped key would activate
 * the focused control.
 */
fun isDpadCenter(key: Key): Boolean = key == Key.DirectionCenter && key != Key.Unknown

/** Keys that activate a focused push button: Enter, numpad Enter, Space, D-pad centre. */
fun isActivateKey(key: Key): Boolean = key == Key.Enter || key == Key.NumPadEnter || key == Key.Spacebar || isDpadCenter(key)

/**
 * Input and semantics of a push button, shared by [PadButton] and the look buttons: taps and
 * Enter / Space / D-pad centre. [press] / [release] give momentary behaviour (CUE); otherwise
 * [click] fires on release. [down] holds the pressed state for the caller's pressed look. [tab]
 * non-null = the control is one of a set and that is its selected state (a tab unless [role] is given).
 */
private fun Modifier.pushButton(
    enabled: Boolean,
    description: String,
    state: String?,
    down: MutableState<Boolean>,
    press: State<(() -> Unit)?>,
    release: State<(() -> Unit)?>,
    click: State<() -> Unit>,
    tab: Boolean? = null,
    role: Role? = null,
): Modifier = this
    .onKeyEvent { e ->
        if (!enabled || !isActivateKey(e.key)) return@onKeyEvent false
        when (e.type) {
            KeyEventType.KeyDown -> {
                if (!down.value) {
                    down.value = true
                    press.value?.invoke()
                }
                true
            }
            KeyEventType.KeyUp -> {
                down.value = false
                if (press.value != null) release.value?.invoke() else click.value()
                true
            }
            else -> false
        }
    }
    .focusable(enabled)
    .pointerInput(enabled) {
        if (!enabled) return@pointerInput
        detectTapGestures(onPress = {
            down.value = true
            press.value?.invoke()
            val up = tryAwaitRelease()
            // Not held any more when the button left the screen meanwhile (ReleaseWhenRemoved let go).
            val held = down.value
            down.value = false
            if (press.value != null) {
                if (held) release.value?.invoke()
            } else if (up) click.value()
        })
    }
    .semantics {
        contentDescription = description
        this.role = role ?: if (tab != null) Role.Tab else Role.Button
        if (tab != null) selected = tab
        state?.let { stateDescription = it }
        if (!enabled) disabled()
        onClick(label = description) {
            if (press.value != null) {
                press.value?.invoke()
                release.value?.invoke()
            } else click.value()
            true
        }
    }

/**
 * A momentary button that leaves the composition while it is held never sees the release (its MORE
 * sheet is dismissed by a second finger, the panel changes its arrangement under the finger): let go
 * for it, or the deck keeps playing from a CUE nobody holds.
 */
@Composable
private fun ReleaseWhenRemoved(down: MutableState<Boolean>, release: State<(() -> Unit)?>) {
    DisposableEffect(Unit) {
        onDispose {
            if (down.value) {
                down.value = false
                release.value?.invoke()
            }
        }
    }
}

/**
 * Makes a custom-drawn element (a list row, a chip) a control: tap, Enter / Space, a focus ring, a
 * name for assistive tech. [selected] non-null = it is one of a set and that is its selected state
 * (spoken as a tab unless [role] says otherwise). [state] = spoken state.
 */
@Composable
fun Modifier.activatable(
    description: String,
    selected: Boolean? = null,
    shape: Shape = RectangleShape,
    role: Role? = null,
    state: String? = null,
    onClick: () -> Unit,
): Modifier {
    var focused by remember { mutableStateOf(false) }
    val down = remember { mutableStateOf(false) }
    val click = rememberUpdatedState(onClick)
    val none = remember { mutableStateOf<(() -> Unit)?>(null) }
    return focusRing(focused, shape).onFocusChanged { focused = it.isFocused }
        .pushButton(true, description, state, down, none, none, click, tab = selected, role = role)
}

/**
 * Push button with optional latched state. [onPress]/[onRelease] give momentary behaviour (CUE);
 * otherwise [onClick] fires on tap / Enter / Space. Minimum 44 dp target (shell chrome: status bar,
 * dock tabs, the pop-up panels). The layout panels use the dense look controls below. [role] = what
 * assistive tech calls it when it is not a plain button (a switch).
 */
@Composable
fun PadButton(
    label: String,
    description: String,
    modifier: Modifier = Modifier,
    active: Boolean = false,
    accent: Color = DecksColors.on,
    enabled: Boolean = true,
    state: String? = null,
    onPress: (() -> Unit)? = null,
    onRelease: (() -> Unit)? = null,
    role: Role? = null,
    onClick: () -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    val down = remember { mutableStateOf(false) }
    val click = rememberUpdatedState(onClick)
    val press = rememberUpdatedState(onPress)
    val release = rememberUpdatedState(onRelease)
    ReleaseWhenRemoved(down, release)
    val bg = when {
        !enabled -> DecksColors.surface
        active || down.value -> accent
        else -> DecksColors.surfaceRaised
    }
    val lit = inkOn(accent)
    val fg = if (active || down.value) lit else if (enabled) DecksColors.foreground else DecksColors.muted
    val skin = LocalDecksSkin.current
    val shape = controlShape(skin)
    val minH = maxOf(44, skin.controlHeightDp).dp
    Box(
        modifier
            .sizeIn(minWidth = 44.dp, minHeight = minH)
            .clip(shape)
            .background(bg, shape)
            .border(1.dp, if (active) accent else DecksColors.border, shape)
            .focusRing(focused, shape)
            .onFocusChanged { focused = it.isFocused }
            .pushButton(enabled, description, state, down, press, release, click, role = role)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        BasicText(label, style = LocalDecksType.current.small.copy(color = fg, textAlign = TextAlign.Center))
    }
}

/**
 * Text on a lit control: whichever of the two ink colours reads better on THIS fill (deck colours,
 * cue colours and a skin's ON / PLAY fills range from near-white to deep blue; `onPrimary` alone was
 * white on Mainroom's near-white deck colour). The ON fill has its own ink role.
 */
@Composable
fun inkOn(fill: Color): Color {
    val onFg = DecksColors.onFg
    val isOn = fill == DecksColors.on
    val a = DecksColors.onPrimary
    val b = DecksColors.background
    return remember(fill, isOn, onFg, a, b) {
        if (isOn) onFg else if (Oklab.contrast(a, fill) >= Oklab.contrast(b, fill)) a else b
    }
}

// ---------------------------------------------------------------------------------------------
// Decks 1.5 look controls (mirror of the `dk-*` vocabulary of apps/mixai/src/look/look.css).
// Dense: 24 dp controls, 9 dp caps labels, flat fills, one ON colour. Sizes are the CSS px as dp.
// ---------------------------------------------------------------------------------------------

/**
 * Test hook: gets the name of every look control that received less room than it needs (a label
 * that does not fit, a target under its minimum size). Null in the apps, where nothing is recorded.
 * desktopTest/ContentMinimumsTest renders every panel in the minimum box of its tier with this set.
 */
val LocalFitProbe = staticCompositionLocalOf<((String) -> Unit)?> { null }

/** Reports to [LocalFitProbe] when this element ends up smaller than [minWidth] × [minHeight]. */
@Composable
fun Modifier.needs(name: String, minWidth: Dp, minHeight: Dp): Modifier {
    val probe = LocalFitProbe.current ?: return this
    val density = LocalDensity.current
    return onSizeChanged { s ->
        val w = with(density) { minWidth.toPx() }
        val h = with(density) { minHeight.toPx() }
        if (s.width < w - 0.5f || s.height < h - 0.5f) probe("$name: ${s.width}x${s.height} px, needs ${w.roundToInt()}x${h.roundToInt()}")
    }
}

/** Corner radius of a performance pad (dp): `--pad-radius` (the control radius unless a skin sets `padRadius`). */
val DecksSkin.padRadiusDp: Float get() = style?.sizes?.get("padRadius")?.toFloat() ?: controlRadiusDp

/**
 * Text styles of the look. Sizes are dp like the px of look.css and do NOT follow the OS font
 * scale: the panels are fixed geometry (zero scroll) and a larger font would be cut, not reflowed.
 */
object LookText {
    @Composable
    @ReadOnlyComposable
    fun sp(px: Float): TextUnit = with(LocalDensity.current) { px.dp.toSp() }

    /** [line] = line height in dp (the text box is exactly that high), [tracking] in em. */
    @Composable
    @ReadOnlyComposable
    fun style(
        px: Float,
        color: Color,
        weight: FontWeight = FontWeight.Normal,
        line: Float = px * 1.2f,
        tracking: Float = 0f,
        tabular: Boolean = false,
    ): TextStyle = TextStyle(
        color = color,
        fontSize = sp(px),
        fontWeight = weight,
        lineHeight = sp(line),
        letterSpacing = if (tracking != 0f) tracking.em else TextUnit.Unspecified,
        fontFeatureSettings = if (tabular) "tnum" else null,
        lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
    )

    /** Micro label: 9 dp bold caps (`dk-label`). */
    @Composable
    @ReadOnlyComposable
    fun label(color: Color = DecksColors.faint): TextStyle = style(9f, color, FontWeight.Bold, line = 12f, tracking = 0.08f)

    /** Readout digits (`dk-num`): tabular, line height = the font size. */
    @Composable
    @ReadOnlyComposable
    fun num(px: Float, color: Color, weight: FontWeight = FontWeight.Bold): TextStyle = style(px, color, weight, line = px, tabular = true)
}

/**
 * One line of text in a box exactly as high as the line height of [style] (CSS semantics). The text
 * engines keep the font's own ascent and descent when the line height is smaller (a 24 dp digit
 * with `line-height: 1` is laid out taller than 24 dp), which would push a readout row out of its
 * 24 dp; here the glyph box is centred on the line box instead. Checked by desktopTest
 * ContentMinimumsTest.aReadoutLineIsExactlyAsHighAsItsLineHeight: this line is exactly as high as its
 * line height (11, 15, 18, 24 and 28 dp digits), and cut digits are reported: 24 dp digits in a 20 dp
 * row, and a value in a box narrower than its text. (That the plain paragraph is taller, 32 dp for
 * 24 dp digits with the desktop font, was measured once and is not asserted.)
 *
 * [fit] = it must show whole (a cut is reported to [LocalFitProbe]); otherwise it may end in an
 * ellipsis (titles, names). A line that gets less height than its line box, or no width at all, is
 * always reported.
 */
@Composable
fun LookLine(text: String, style: TextStyle, modifier: Modifier = Modifier, fit: Boolean = true) {
    val probe = LocalFitProbe.current
    val linePx = if (style.lineHeight.isSp) with(LocalDensity.current) { style.lineHeight.toPx().roundToInt() } else 0
    val onLayout: ((TextLayoutResult) -> Unit)? = probe?.let { report ->
        { r: TextLayoutResult ->
            if ((fit && r.didOverflowWidth) || (text.isNotEmpty() && r.size.width == 0)) report("text \"$text\" is cut")
        }
    }
    val box = remember(linePx, probe, text) { Modifier.lineBox(linePx) { got -> probe?.invoke("text \"$text\" is cut: a $linePx px line in $got px") } }
    BasicText(
        text, modifier.then(box), style, onTextLayout = onLayout,
        overflow = if (fit) TextOverflow.Clip else TextOverflow.Ellipsis, softWrap = false, maxLines = 1,
    )
}

/** Makes the element [linePx] high whatever height the text engine gives the paragraph, centred, baselines kept. */
private fun Modifier.lineBox(linePx: Int, onCut: (Int) -> Unit): Modifier = if (linePx <= 0) this else layout { measurable, constraints ->
    val p = measurable.measure(constraints.copy(minHeight = 0, maxHeight = Constraints.Infinity))
    if (constraints.maxHeight < linePx) onCut(constraints.maxHeight)
    val height = linePx.coerceIn(constraints.minHeight, maxOf(constraints.minHeight, constraints.maxHeight))
    val y = (height - p.height) / 2
    val first = p[FirstBaseline]
    val last = p[LastBaseline]
    val lines: Map<AlignmentLine, Int> =
        if (first != AlignmentLine.Unspecified && last != AlignmentLine.Unspecified) mapOf(FirstBaseline to first + y, LastBaseline to last + y) else emptyMap()
    layout(p.width, height, lines) { p.place(0, y) }
}

/** Micro label in caps (`dk-label`). */
@Composable
fun MicroLabel(text: String, modifier: Modifier = Modifier, color: Color = DecksColors.faint) {
    LookLine(text.uppercase(), LookText.label(color), modifier)
}

/** Small vector marks for the dense controls (no icon font in commonMain). */
enum class Glyph { Play, Pause, Lock, Unlock, Minus, Plus, Left, Right, Rewind, Forward, More, Phones, Close, Warn, Check, Eraser }

private fun DrawScope.drawGlyph(g: Glyph, c: Color) {
    val s = size.minDimension
    val ox = (size.width - s) / 2
    val oy = (size.height - s) / 2
    val w = s * 0.14f
    fun p(x: Float, y: Float) = Offset(ox + x * s, oy + y * s)
    fun line(x0: Float, y0: Float, x1: Float, y1: Float, width: Float = w) = drawLine(c, p(x0, y0), p(x1, y1), width, StrokeCap.Round)
    fun poly(vararg xy: Float, fill: Boolean = false, close: Boolean = false) {
        val path = Path()
        path.moveTo(ox + xy[0] * s, oy + xy[1] * s)
        var i = 2
        while (i + 1 < xy.size) {
            path.lineTo(ox + xy[i] * s, oy + xy[i + 1] * s)
            i += 2
        }
        if (fill || close) path.close()
        if (fill) drawPath(path, c) else drawPath(path, c, style = Stroke(w, cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
    fun lockBody() = drawRoundRect(c, p(0.18f, 0.46f), Size(s * 0.64f, s * 0.46f), CornerRadius(s * 0.08f))
    when (g) {
        Glyph.Play -> poly(0.26f, 0.14f, 0.86f, 0.5f, 0.26f, 0.86f, fill = true)
        Glyph.Pause -> {
            drawRect(c, p(0.2f, 0.14f), Size(s * 0.22f, s * 0.72f))
            drawRect(c, p(0.58f, 0.14f), Size(s * 0.22f, s * 0.72f))
        }
        Glyph.Lock -> {
            lockBody()
            drawArc(c, 180f, 180f, false, p(0.3f, 0.12f), Size(s * 0.4f, s * 0.68f), style = Stroke(w))
        }
        Glyph.Unlock -> {
            lockBody()
            drawArc(c, 180f, 140f, false, p(0.3f, 0.02f), Size(s * 0.4f, s * 0.68f), style = Stroke(w))
        }
        Glyph.Minus -> line(0.2f, 0.5f, 0.8f, 0.5f)
        Glyph.Plus -> {
            line(0.2f, 0.5f, 0.8f, 0.5f)
            line(0.5f, 0.2f, 0.5f, 0.8f)
        }
        Glyph.Left -> poly(0.62f, 0.18f, 0.3f, 0.5f, 0.62f, 0.82f)
        Glyph.Right -> poly(0.38f, 0.18f, 0.7f, 0.5f, 0.38f, 0.82f)
        Glyph.Rewind -> {
            poly(0.5f, 0.2f, 0.2f, 0.5f, 0.5f, 0.8f)
            poly(0.84f, 0.2f, 0.54f, 0.5f, 0.84f, 0.8f)
        }
        Glyph.Forward -> {
            poly(0.16f, 0.2f, 0.46f, 0.5f, 0.16f, 0.8f)
            poly(0.5f, 0.2f, 0.8f, 0.5f, 0.5f, 0.8f)
        }
        Glyph.More -> for (x in listOf(0.18f, 0.5f, 0.82f)) drawCircle(c, s * 0.09f, p(x, 0.5f))
        Glyph.Phones -> {
            drawArc(c, 180f, 180f, false, p(0.16f, 0.14f), Size(s * 0.68f, s * 0.8f), style = Stroke(w))
            drawRoundRect(c, p(0.08f, 0.52f), Size(s * 0.2f, s * 0.34f), CornerRadius(s * 0.06f))
            drawRoundRect(c, p(0.72f, 0.52f), Size(s * 0.2f, s * 0.34f), CornerRadius(s * 0.06f))
        }
        Glyph.Close -> {
            line(0.22f, 0.22f, 0.78f, 0.78f)
            line(0.78f, 0.22f, 0.22f, 0.78f)
        }
        Glyph.Warn -> {
            poly(0.5f, 0.12f, 0.92f, 0.86f, 0.08f, 0.86f, close = true)
            line(0.5f, 0.4f, 0.5f, 0.58f, s * 0.1f)
            drawCircle(c, s * 0.06f, p(0.5f, 0.73f))
        }
        Glyph.Check -> poly(0.16f, 0.54f, 0.4f, 0.78f, 0.84f, 0.26f)
        Glyph.Eraser -> {
            // A slanted block (its lower half is the rubber) on a base line.
            poly(0.52f, 0.12f, 0.88f, 0.48f, 0.56f, 0.8f, 0.2f, 0.44f, close = true)
            line(0.36f, 0.28f, 0.72f, 0.64f)
            line(0.14f, 0.9f, 0.86f, 0.9f)
        }
    }
}

/** A [Glyph] as a small decorative mark (no semantics: the control around it carries the name). */
@Composable
fun GlyphIcon(glyph: Glyph, color: Color, modifier: Modifier = Modifier, size: Dp = 12.dp) {
    Canvas(modifier.size(size)) { drawGlyph(glyph, color) }
}

/** Look of an [OnButton]. */
enum class BtnKind {
    /** `dk-btn`: raised fill, hairline; ON = the ON colour (or the caller's accent) plus an inner line. */
    Std,

    /** `dk-btn-play`: lit = a solid fill in the PLAY colour (pass it as the accent). */
    Play,

    /** `dk-btn-cue`: outlined in the CUE colour, solid while held or lit. */
    Cue,

    /** `dk-cell`: a well; selected = a 2 dp outline in the ON colour, no fill. */
    Cell,
}

/**
 * Dense control button of the look ([BtnKind]); the target is never under 24 dp. ON is never
 * colour only: the inner line / outline changes with it and the state is spoken ([state]).
 * [onPress] / [onRelease] give momentary behaviour (CUE); otherwise [onClick] fires on tap / Enter / Space.
 * [tint] = colour of the label / glyph while the button is not lit (a deck letter in its deck colour).
 */
@Composable
fun OnButton(
    label: String?,
    description: String,
    modifier: Modifier = Modifier,
    on: Boolean = false,
    enabled: Boolean = true,
    glyph: Glyph? = null,
    kind: BtnKind = BtnKind.Std,
    accent: Color = Color.Unspecified,
    tint: Color = Color.Unspecified,
    state: String? = null,
    padH: Dp = 8.dp,
    onPress: (() -> Unit)? = null,
    onRelease: (() -> Unit)? = null,
    onClick: () -> Unit = {},
) {
    val skin = LocalDecksSkin.current
    val shape = controlShape(skin)
    var focused by remember { mutableStateOf(false) }
    val down = remember { mutableStateOf(false) }
    val click = rememberUpdatedState(onClick)
    val press = rememberUpdatedState(onPress)
    val release = rememberUpdatedState(onRelease)
    ReleaseWhenRemoved(down, release)
    val held = down.value && enabled
    val tone = if (accent != Color.Unspecified) accent else if (kind == BtnKind.Cue) DecksColors.cueButton else DecksColors.on
    val ink = inkOn(tone)
    val raised = DecksColors.surfaceRaised
    val well = DecksColors.well
    val text = DecksColors.foreground
    val pressed = remember(raised, well, text, kind) { Oklab.mix(if (kind == BtnKind.Cell) well else raised, text, 0.8f) }
    val bg: Color
    val fg: Color
    val edge: Color
    when (kind) {
        BtnKind.Cell -> {
            bg = if (held) pressed else well
            fg = if (tint != Color.Unspecified) tint else if (on) text else DecksColors.muted
            edge = Color.Transparent
        }
        BtnKind.Cue -> {
            val lit = on || held
            bg = if (lit) tone else raised
            fg = if (lit) DecksColors.background else tone
            edge = if (lit) tone else tone.copy(alpha = 0.55f)
        }
        else -> {
            bg = if (on) tone else if (held) pressed else raised
            fg = if (on) ink else if (tint != Color.Unspecified) tint else text
            edge = if (on) tone else DecksColors.border
        }
    }
    // ON is not colour only: Std gets an inner hairline, a cell a 2 dp outline in the ON colour.
    val inner = when {
        !on -> Color.Unspecified
        kind == BtnKind.Std -> ink.copy(alpha = 0.35f)
        kind == BtnKind.Cell -> DecksColors.on
        else -> Color.Unspecified
    }
    val radius = skin.controlRadiusDp
    Box(
        modifier
            .sizeIn(minWidth = 24.dp, minHeight = 24.dp)
            .needs(description, 24.dp, 24.dp)
            .alpha(if (enabled) 1f else 0.4f)
            .clip(shape)
            .background(bg, shape)
            .border(1.dp, edge, shape)
            .drawBehind {
                if (inner != Color.Unspecified) {
                    val cell = kind == BtnKind.Cell
                    val stroke = (if (cell) 2.dp else 1.dp).toPx()
                    val inset = if (cell) stroke / 2 else 1.5.dp.toPx()
                    val r = (radius.dp.toPx() - inset).coerceAtLeast(0f)
                    drawRoundRect(
                        inner, Offset(inset, inset), Size(size.width - inset * 2, size.height - inset * 2),
                        CornerRadius(r), style = Stroke(stroke),
                    )
                }
            }
            .focusRing(focused, shape)
            .onFocusChanged { focused = it.isFocused }
            .pushButton(enabled, description, state, down, press, release, click)
            .padding(horizontal = if (label == null) 0.dp else padH),
        contentAlignment = Alignment.Center,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (glyph != null) GlyphIcon(glyph, fg, size = if (kind == BtnKind.Play) 13.dp else 11.dp)
            if (label != null) {
                val style = when (kind) {
                    BtnKind.Cell -> LookText.style(10f, fg, FontWeight.Bold, line = 12f, tabular = true)
                    BtnKind.Play, BtnKind.Cue -> LookText.style(11f, fg, FontWeight.Bold, line = 13f, tracking = 0.06f)
                    else -> LookText.style(10f, fg, FontWeight.Bold, line = 12f, tracking = 0.06f)
                }
                LookLine(label, style)
            }
        }
    }
}

/**
 * Performance pad (`dk-pad`): a well with a 4 dp colour bar when [set]; an empty pad is a dashed
 * outline (shape, not colour only). [number] is the pad's digit, [detail] what it holds (a time).
 */
@Composable
fun CuePad(
    number: String,
    detail: String?,
    description: String,
    set: Boolean,
    color: Color,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val skin = LocalDecksSkin.current
    val shape = RoundedCornerShape(skin.padRadiusDp.dp)
    val radius = skin.padRadiusDp
    var focused by remember { mutableStateOf(false) }
    val down = remember { mutableStateOf(false) }
    val click = rememberUpdatedState(onClick)
    val none = remember { mutableStateOf<(() -> Unit)?>(null) }
    val well = DecksColors.well
    val line = DecksColors.border
    val lit = remember(color, well) { Oklab.mix(color, well, 0.28f) }
    val bg = if (down.value && enabled) lit else if (set) well else Color.Transparent
    Box(
        modifier
            .sizeIn(minWidth = 24.dp, minHeight = 24.dp)
            .needs(description, 24.dp, 24.dp)
            .alpha(if (enabled) 1f else 0.4f)
            .clip(shape)
            .background(bg, shape)
            .drawBehind {
                if (set) {
                    drawRect(color, size = Size(size.width, 4.dp.toPx()))
                }
            }
            .then(if (set) Modifier else Modifier.dashedOutline(line, radius.dp))
            .focusRing(focused, shape)
            .onFocusChanged { focused = it.isFocused }
            .pushButton(enabled, description, null, down, none, none, click)
            .padding(start = 6.dp, end = 4.dp, top = 4.dp, bottom = 3.dp),
        contentAlignment = Alignment.BottomStart,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            LookLine(number, LookText.style(10f, if (set) DecksColors.foreground else DecksColors.faint, FontWeight.ExtraBold, line = 12f))
            if (detail != null) {
                LookLine(detail, LookText.style(10f, DecksColors.muted, FontWeight.SemiBold, line = 12f, tabular = true), fit = false)
            }
        }
    }
}

/**
 * Tab row of the look (`dk-tab`): caps labels on a hairline, the selected one in the foreground
 * colour with a 2 dp underline in the ON colour (shape, not colour only). 24 dp high. Left / Right
 * step the selection. [trailing] = controls at the right end of the row; [tags] = a test name per tab ([tag]).
 */
@Composable
fun TierTabs(
    labels: List<String>,
    selected: Int,
    modifier: Modifier = Modifier,
    tags: List<String>? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    onSelect: (Int) -> Unit,
) {
    val line = DecksColors.border
    Row(
        modifier.fillMaxWidth().height(24.dp)
            .drawBehind { drawRect(line, Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx())) }
            .selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        labels.forEachIndexed { i, label ->
            LookTab(label, i == selected, tags?.getOrNull(i), onClick = { onSelect(i) }) { step -> onSelect((i + step).mod(labels.size)) }
        }
        if (trailing != null) {
            Box(Modifier.weight(1f))
            trailing()
        }
    }
}

@Composable
private fun LookTab(label: String, selected: Boolean, tag: String?, onClick: () -> Unit, onStep: (Int) -> Unit) {
    val shape = controlShape(LocalDecksSkin.current)
    var focused by remember { mutableStateOf(false) }
    val down = remember { mutableStateOf(false) }
    val click = rememberUpdatedState(onClick)
    val step by rememberUpdatedState(onStep)
    val none = remember { mutableStateOf<(() -> Unit)?>(null) }
    val on = DecksColors.on
    Box(
        Modifier.fillMaxHeight().sizeIn(minWidth = 24.dp)
            .needs(label, 24.dp, 24.dp)
            .then(if (tag != null) Modifier.tag(tag) else Modifier)
            .drawBehind { if (selected) drawRect(on, Offset(0f, size.height - 2.dp.toPx()), Size(size.width, 2.dp.toPx())) }
            .focusRing(focused, shape)
            .onFocusChanged { focused = it.isFocused }
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
                when (e.key) {
                    Key.DirectionRight -> { step(1); true }
                    Key.DirectionLeft -> { step(-1); true }
                    else -> false
                }
            }
            .pushButton(true, label, null, down, none, none, click, tab = selected)
            .padding(horizontal = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        MicroLabel(label, color = if (selected) DecksColors.foreground else DecksColors.faint)
    }
}

/**
 * Key chip (`dk-key`): the Camelot key on a low fill of its key colour, text at 70 % of the key
 * colour over the foreground. No key = an em dash on the raised fill.
 */
@Composable
fun KeyChip(key: String?, modifier: Modifier = Modifier, suffix: String = "") {
    val has = !key.isNullOrBlank()
    val tone = DecksColors.key(key)
    val text = DecksColors.foreground
    val fg = remember(tone, text, has) { if (has) Oklab.mix(tone, text, 0.7f) else tone }
    Box(
        modifier.height(18.dp)
            .background(if (has) tone.copy(alpha = 0.22f) else DecksColors.surfaceRaised, controlShape(LocalDecksSkin.current))
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        LookLine((if (has) key.orEmpty().trim() else "—") + suffix, LookText.style(11f, fg, FontWeight.Bold, line = 13f, tabular = true))
    }
}

/** Accessible continuous control shared by the knobs and faders: arrow keys, TalkBack setProgress. */
private fun Modifier.rangeControl(
    description: String,
    valueText: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    step: Float,
    onChange: (Float) -> Unit,
    onReset: () -> Unit,
): Modifier = this
    .onKeyEvent { e ->
        if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
        when (e.key) {
            Key.DirectionUp, Key.DirectionRight -> { onChange((value + step).coerceIn(range)); true }
            Key.DirectionDown, Key.DirectionLeft -> { onChange((value - step).coerceIn(range)); true }
            Key.PageUp -> { onChange((value + step * 5).coerceIn(range)); true }
            Key.PageDown -> { onChange((value - step * 5).coerceIn(range)); true }
            Key.Delete, Key.Backspace, Key.Zero -> { onReset(); true }
            else -> false
        }
    }
    .focusable()
    .semantics {
        contentDescription = description
        stateDescription = valueText
        progressBarRangeInfo = ProgressBarRangeInfo(value, range)
        setProgress { t -> onChange(t.coerceIn(range)); true }
    }

/**
 * Small rotary knob (`mx-knob`, 24 dp): vertical drag, double tap resets to [default]; the arc runs
 * from the default to the value in [color]. [label] is the hardware legend under it (caps); the
 * column is [width] wide so stacked knobs line up.
 */
@Composable
fun KnobSmall(
    label: String?,
    description: String,
    valueText: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    default: Float,
    modifier: Modifier = Modifier,
    color: Color = DecksColors.muted,
    size: Dp = 24.dp,
    width: Dp = 36.dp,
    onChange: (Float) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val current by rememberUpdatedState(value)
    val change by rememberUpdatedState(onChange)
    val span = range.endInclusive - range.start
    val track = DecksColors.foreground.copy(alpha = 0.24f)
    val body = DecksColors.surfaceRaised
    val edge = if (focused) DecksColors.ring else DecksColors.border
    val pointer = DecksColors.foreground
    Column(modifier.width(width), horizontalAlignment = Alignment.CenterHorizontally) {
        Canvas(
            Modifier
                .size(size)
                .needs(description, size, size)
                .onFocusChanged { focused = it.isFocused }
                .pointerInput(range) {
                    detectDragGestures { ch, drag ->
                        ch.consume()
                        change((current - drag.y / 120f * span + drag.x / 240f * span).coerceIn(range))
                    }
                }
                .pointerInput(default) { detectTapGestures(onDoubleTap = { change(default) }) }
                .rangeControl(description, valueText, value, range, span / 40f, onChange) { onChange(default) },
        ) {
            val stroke = 2.dp.toPx()
            val r = this.size.minDimension / 2 - stroke / 2
            val c = Offset(this.size.width / 2, this.size.height / 2)
            val tl = Offset(c.x - r, c.y - r)
            val arc = Size(r * 2, r * 2)
            drawArc(track, 135f, 270f, false, tl, arc, style = Stroke(stroke))
            val frac = ((value - range.start) / span).coerceIn(0f, 1f)
            val zero = ((default - range.start) / span).coerceIn(0f, 1f)
            val a0 = 135f + 270f * zero
            val a1 = 135f + 270f * frac
            if (a0 != a1) drawArc(color, minOf(a0, a1), abs(a1 - a0), false, tl, arc, style = Stroke(stroke))
            val rb = r - stroke * 1.5f
            drawCircle(body, rb, c)
            drawCircle(edge, rb, c, style = Stroke((if (focused) 2.dp else 1.dp).toPx()))
            val ang = a1 * PI / 180.0
            val dx = cos(ang).toFloat()
            val dy = sin(ang).toFloat()
            drawLine(pointer, Offset(c.x + dx * rb * 0.25f, c.y + dy * rb * 0.25f), Offset(c.x + dx * (rb - 1f), c.y + dy * (rb - 1f)), 2.dp.toPx(), StrokeCap.Round)
        }
        if (label != null) LookLine(label.uppercase(), LookText.style(9f, DecksColors.faint, FontWeight.Bold, line = 10f, tracking = 0.08f))
    }
}

/** Look of a [FlatFader]. */
enum class FaderLook {
    /** Vertical channel fader (`mx-fader`): a well, a 2 dp slot, the level filled in the fader colour, a 12 dp cap. */
    Channel,

    /** Horizontal crossfader (`xf-fader`): a well, no fill, a centre mark under a 14 dp cap. */
    Cross,

    /** Horizontal tempo fader (`deck-tempo-track`): a groove with a centre detent, the deviation filled in the fader colour. */
    Tempo,
}

/**
 * Flat fader of the look ([FaderLook]). Drag or arrow keys; double tap (or Delete) returns to
 * [default]; a pointer within 3 % of [detent] snaps to it. 24 dp minimum in both directions.
 */
@Composable
fun FlatFader(
    description: String,
    valueText: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    default: Float,
    modifier: Modifier = Modifier,
    look: FaderLook = FaderLook.Channel,
    color: Color = DecksColors.muted,
    detent: Float? = null,
    step: Float = (range.endInclusive - range.start) / 50f,
    onChange: (Float) -> Unit,
) {
    val vertical = look == FaderLook.Channel
    var focused by remember { mutableStateOf(false) }
    val change by rememberUpdatedState(onChange)
    val span = range.endInclusive - range.start
    val radius = LocalDecksSkin.current.controlRadiusDp
    val well = DecksColors.well
    val fg = DecksColors.foreground
    val card = DecksColors.surface
    val ring = DecksColors.ring
    val faint = DecksColors.faint
    val line = DecksColors.border
    // Half of the cap: the value 0..1 maps onto the track between the two insets.
    val insetDp = when (look) { FaderLook.Channel -> 6f; FaderLook.Cross -> 7f; FaderLook.Tempo -> 4f }
    Canvas(
        modifier
            .sizeIn(minWidth = 24.dp, minHeight = 24.dp)
            .needs(description, 24.dp, 24.dp)
            .onFocusChanged { focused = it.isFocused }
            .pointerInput(range, look, detent) {
                fun at(o: Offset): Float {
                    val inset = insetDp.dp.toPx()
                    val f = if (vertical) 1f - (o.y - inset) / (size.height - inset * 2) else (o.x - inset) / (size.width - inset * 2)
                    val v = range.start + span * f.coerceIn(0f, 1f)
                    return if (detent != null && abs(v - detent) < span * 0.03f) detent else v
                }
                detectDragGestures(onDragStart = { change(at(it)) }) { ch, _ -> ch.consume(); change(at(ch.position)) }
            }
            .pointerInput(default) { detectTapGestures(onDoubleTap = { change(default) }) }
            .rangeControl(description, valueText, value, range, step, onChange) { onChange(default) },
    ) {
        val w = size.width
        val h = size.height
        val f = ((value - range.start) / span).coerceIn(0f, 1f)
        val inset = insetDp.dp.toPx()
        val two = 2.dp.toPx()
        val capColor = if (focused) ring else fg
        val slot = fg.copy(alpha = 0.24f)
        when (look) {
            FaderLook.Channel -> {
                drawRoundRect(well, cornerRadius = CornerRadius(radius.dp.toPx()))
                val x = w / 2 - two / 2
                drawRect(slot, Offset(x, inset), Size(two, h - inset * 2))
                val cy = inset + (1f - f) * (h - inset * 2)
                drawRect(color, Offset(x, cy), Size(two, (h - inset - cy).coerceAtLeast(0f)))
                drawRoundRect(capColor, Offset(two, cy - inset), Size(w - two * 2, inset * 2), CornerRadius(1.dp.toPx()))
                drawRect(card, Offset(two + 3.dp.toPx(), cy - two / 2), Size((w - two * 2 - 6.dp.toPx()).coerceAtLeast(0f), two))
            }
            FaderLook.Cross -> {
                drawRoundRect(well, cornerRadius = CornerRadius(radius.dp.toPx()))
                drawRect(slot, Offset(inset, h / 2 - two / 2), Size(w - inset * 2, two))
                drawRect(fg.copy(alpha = 0.4f), Offset(w / 2 - two / 2, 3.dp.toPx()), Size(two, (h - 6.dp.toPx()).coerceAtLeast(0f)))
                val cx = inset + f * (w - inset * 2)
                drawRoundRect(capColor, Offset(cx - inset, two), Size(inset * 2, h - two * 2), CornerRadius(1.dp.toPx()))
                drawRect(card, Offset(cx - two / 2, two + 3.dp.toPx()), Size(two, (h - two * 2 - 6.dp.toPx()).coerceAtLeast(0f)))
            }
            FaderLook.Tempo -> {
                drawRect(line, Offset(6.dp.toPx(), h / 2 - two / 2), Size(w - 12.dp.toPx(), two))
                drawRect(faint, Offset(w / 2 - two / 2, 4.dp.toPx()), Size(two, (h - 8.dp.toPx()).coerceAtLeast(0f)))
                val cx = inset + f * (w - inset * 2)
                drawRect(color, Offset(minOf(cx, w / 2), h / 2 - two / 2), Size(abs(cx - w / 2), two))
                val th = minOf(18.dp.toPx(), h)
                drawRoundRect(capColor, Offset(cx - inset, (h - th) / 2), Size(inset * 2, th), CornerRadius(1.dp.toPx()))
            }
        }
        if (focused && look != FaderLook.Tempo) {
            drawRoundRect(ring, Offset(1f, 1f), Size(w - 2f, h - 2f), CornerRadius(radius.dp.toPx()), style = Stroke(two))
        }
    }
}

/**
 * Segmented level meter 0..1 (`mx-vu`): 4 dp cells with 2 dp gaps, green, then amber, then red at
 * the top. [columns] side by side (the master meter has two). [level] is read while drawing, so a
 * moving meter redraws without recomposing the panel around it. Decorative to TalkBack.
 */
@Composable
fun SegMeter(level: () -> Float, modifier: Modifier = Modifier, vertical: Boolean = true, columns: Int = 1) {
    val off = DecksColors.surfaceRaised
    val ok = DecksColors.success
    val hot = DecksColors.warning
    val clip = DecksColors.danger
    val drawn = LocalRecomposeProbe.current
    Canvas(modifier.needs("level meter", if (vertical) 4.dp else 16.dp, if (vertical) 16.dp else 4.dp)) {
        drawn?.invoke("meter:draw")
        val gap = 2.dp.toPx()
        val len = if (vertical) size.height else size.width
        val cross = if (vertical) size.width else size.height
        val n = ((len + gap) / (4.dp.toPx() + gap)).toInt().coerceAtLeast(1)
        val pitch = (len + gap) / n
        val cell = pitch - gap
        val lit = (level().coerceIn(0f, 1f) * n).toInt()
        val clipFrom = n - maxOf(1, (n * 0.1f).roundToInt())
        val hotFrom = clipFrom - maxOf(1, (n * 0.2f).roundToInt())
        val cols = columns.coerceAtLeast(1)
        val colSize = (cross - gap * (cols - 1)) / cols
        val corner = CornerRadius(1f)
        for (i in 0 until n) {
            val c = if (i >= lit) off else if (i >= clipFrom) clip else if (i >= hotFrom) hot else ok
            val main = if (vertical) len - i * pitch - cell else i * pitch
            for (k in 0 until cols) {
                val side = k * (colSize + gap)
                if (vertical) drawRoundRect(c, Offset(side, main), Size(colSize, cell), corner)
                else drawRoundRect(c, Offset(main, side), Size(cell, colSize), corner)
            }
        }
    }
}

/**
 * Phase meter: the deck's beat offset against the master clock (−½ … +½ beat); centre = in phase.
 * [offsetBeats] is read while drawing (it moves every frame): null = nothing to compare with.
 */
@Composable
fun PhaseMeter(offsetBeats: () -> Double?, deckIndex: Int, description: String, modifier: Modifier) {
    val track = DecksColors.surfaceRaised
    val line = DecksColors.border
    val inPhase = DecksColors.success
    val deck = DecksColors.deck(deckIndex)
    Canvas(modifier.semantics { contentDescription = description }) {
        val mid = size.width / 2
        drawRect(track)
        drawLine(line, Offset(mid, 0f), Offset(mid, size.height), 1f)
        val offset = offsetBeats() ?: return@Canvas
        val x = mid + (offset * 2 * mid).toFloat()
        val w = 10.dp.toPx()
        drawRect(if (abs(offset) < 0.03) inPhase else deck, Offset(x - w / 2, 0f), Size(w, size.height))
    }
}

/** A 1 dp dashed outline (an empty pad, a status that is off): a shape, so the state is not colour only. */
fun Modifier.dashedOutline(color: Color, radius: Dp): Modifier = drawBehind {
    val dash = 3.dp.toPx()
    drawRoundRect(
        color, Offset(0.5f, 0.5f), Size(size.width - 1f, size.height - 1f), CornerRadius(radius.toPx()),
        style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash))),
    )
}

/**
 * Outer width (dp) of a deck's / the mixer's MORE sheet when the window has room (400 / 304 dp of controls plus
 * the sheet's 8 dp padding on each side), and the margin a sheet keeps to the window edge.
 */
const val MORE_SHEET_W_DP = 416
const val MIXER_SHEET_W_DP = 320
const val MORE_SHEET_MARGIN_DP = 8

/**
 * Outer width (dp) of a MORE sheet in a window [windowW] dp wide: [preferred], but never wider than the window
 * minus [MORE_SHEET_MARGIN_DP] on each side (a phone is 360 to 412 dp wide: the rows of the sheet then wrap).
 * [windowW] null or 0 = unknown: the preferred width.
 */
fun sheetWidthDp(preferred: Int, windowW: Double?): Double =
    if (windowW == null || !(windowW > 0)) preferred.toDouble() else minOf(preferred.toDouble(), maxOf(0.0, windowW - 2 * MORE_SHEET_MARGIN_DP))

/**
 * Popup that holds what a smaller tier has no room for (the "more" sheet of a deck / the mixer).
 * It opens above its anchor (the parent of the call site), right-aligned with it, or below when
 * there is no room above, and never leaves the window. Escape / Back / a click outside closes it.
 * It takes the focus and a click outside only closes it (the click does not reach what is under
 * the sheet), and below its anchor it can lie over the panel it belongs to: a sheet whose anchor
 * is above controls that must stay one tap away carries them itself (the deck's sheet opened from
 * the header starts with CUE and PLAY; desktopTest MoreSheetWindowTest).
 * [preferredWidthDp] = its outer width when the window has room ([sheetWidthDp]); the content is
 * exactly that wide (minus the padding), so its rows wrap on a phone, and it scrolls vertically when
 * it is taller than the window minus the margin.
 */
@Composable
fun MorePopup(onDismiss: () -> Unit, preferredWidthDp: Int = MORE_SHEET_W_DP, content: @Composable () -> Unit) {
    val density = LocalDensity.current
    val gap = with(density) { 4.dp.roundToPx() }
    val window = LocalWindowInfo.current.containerSize
    val windowW = with(density) { window.width.toDp().value.toDouble() }
    val windowH = with(density) { window.height.toDp().value.toDouble() }
    val outerW = sheetWidthDp(preferredWidthDp, windowW)
    val maxH = if (windowH > 0) (windowH - 2 * MORE_SHEET_MARGIN_DP).coerceAtLeast(48.0) else MAX_SHEET_H_DP
    val margin = with(density) { MORE_SHEET_MARGIN_DP.dp.roundToPx() }
    val provider = remember(gap, margin) {
        object : PopupPositionProvider {
            override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
                // Right-aligned with the anchor; inside the window, with the margin on every side when it has the room.
                fun inside(want: Int, window: Int, size: Int): Int {
                    val last = window - size - margin
                    return if (last >= margin) want.coerceIn(margin, last) else maxOf(0, (window - size) / 2)
                }
                val x = inside(anchorBounds.right - popupContentSize.width, windowSize.width, popupContentSize.width)
                val above = anchorBounds.top - gap - popupContentSize.height
                val below = anchorBounds.bottom + gap
                val y = when {
                    above >= margin -> above
                    below + popupContentSize.height <= windowSize.height - margin -> below
                    else -> inside(windowSize.height, windowSize.height, popupContentSize.height)
                }
                return IntOffset(x, y)
            }
        }
    }
    Popup(popupPositionProvider = provider, onDismissRequest = onDismiss, properties = PopupProperties(focusable = true)) {
        val shape = panelShape(LocalDecksSkin.current)
        Box(
            Modifier.width(outerW.dp).sizeIn(maxHeight = maxH.dp)
                .clip(shape).background(DecksColors.surface).border(1.dp, DecksColors.foreground.copy(alpha = 0.35f), shape)
                .verticalScroll(rememberScrollState())
                .padding(8.dp),
        ) { content() }
    }
}

/** Height cap (dp) of a MORE sheet when the window size is unknown. */
private const val MAX_SHEET_H_DP = 2000.0

/**
 * A layout panel tile. [verticalPad] / [horizontalPad] replace the look's panel padding (thin
 * strips, edge-to-edge lists); [decoration] draws over the panel fill, under the content (a deck's
 * identity line, its end-of-track frame).
 */
@Composable
fun Panel(
    modifier: Modifier = Modifier,
    verticalPad: Dp? = null,
    horizontalPad: Dp? = null,
    decoration: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val skin = LocalDecksSkin.current
    val shape = panelShape(skin)
    // Signature look: flat tiles, no outline (look.css `.panel { border: 0 }`); the classic look keeps its border.
    val outlined = !skin.signature || skin.highContrast
    Box(
        modifier
            .clip(shape)
            .background(DecksColors.surface)
            .then(if (outlined) Modifier.border(1.dp, DecksColors.border, shape) else Modifier)
            .then(decoration)
            .padding(horizontal = horizontalPad ?: skin.panelPadDp.dp, vertical = verticalPad ?: skin.panelPadDp.dp),
    ) { content() }
}
