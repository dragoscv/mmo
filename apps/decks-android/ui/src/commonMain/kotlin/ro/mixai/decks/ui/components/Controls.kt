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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksSkin
import ro.mixai.decks.ui.theme.LocalDecksType
import ro.mixai.decks.ui.theme.controlShape
import ro.mixai.decks.ui.theme.panelShape

/** Focus ring shared by every interactive control (keyboard users must see where they are). */
@Composable
private fun Modifier.focusRing(focused: Boolean, shape: androidx.compose.ui.graphics.Shape): Modifier =
    if (focused) border(2.dp, DecksColors.ring, shape) else this

/**
 * Push button with optional latched state. [onPress]/[onRelease] give momentary behaviour (CUE);
 * otherwise [onClick] fires on tap / Enter / Space. Minimum 44 dp target.
 */
@Composable
fun PadButton(
    label: String,
    description: String,
    modifier: Modifier = Modifier,
    active: Boolean = false,
    accent: Color = DecksColors.primary,
    enabled: Boolean = true,
    state: String? = null,
    onPress: (() -> Unit)? = null,
    onRelease: (() -> Unit)? = null,
    onClick: () -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    var down by remember { mutableStateOf(false) }
    val click by rememberUpdatedState(onClick)
    val press by rememberUpdatedState(onPress)
    val release by rememberUpdatedState(onRelease)
    val bg = when {
        !enabled -> DecksColors.surface
        active || down -> accent
        else -> DecksColors.surfaceRaised
    }
    // Text on a lit button: whichever of the two ink colours reads better on THIS accent (deck colours, cue
    // colours and a skin's ON / PLAY fills range from near-white to deep blue; `onPrimary` alone was white on
    // Mainroom's near-white deck colour).
    val onPrimary = DecksColors.onPrimary
    val ink = DecksColors.background
    val lit = remember(accent, onPrimary, ink) {
        if (ro.mixai.decks.ui.theme.Oklab.contrast(onPrimary, accent) >= ro.mixai.decks.ui.theme.Oklab.contrast(ink, accent)) onPrimary else ink
    }
    val fg = if (active || down) lit else if (enabled) DecksColors.foreground else DecksColors.muted
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
            .onKeyEvent { e ->
                if (!enabled || (e.key != Key.Enter && e.key != Key.Spacebar && e.key != Key.NumPadEnter)) return@onKeyEvent false
                when (e.type) {
                    KeyEventType.KeyDown -> { if (!down) { down = true; press?.invoke() ?: Unit }; true }
                    KeyEventType.KeyUp -> { down = false; if (press != null) release?.invoke() else click(); true }
                    else -> false
                }
            }
            .focusable(enabled)
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectTapGestures(onPress = {
                    down = true
                    press?.invoke()
                    val up = tryAwaitRelease()
                    down = false
                    if (press != null) release?.invoke() else if (up) click()
                })
            }
            .semantics {
                contentDescription = description
                role = Role.Button
                state?.let { stateDescription = it }
                onClick(label = description) { if (press != null) { press?.invoke(); release?.invoke() } else click(); true }
            }
            .padding(horizontal = 10.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        BasicText(label, style = LocalDecksType.current.small.copy(color = fg, textAlign = TextAlign.Center))
    }
}

/** Accessible continuous control shared by [Knob] and [Fader]: arrow keys, TalkBack setProgress. */
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

/** Rotary knob: vertical drag, double tap resets to [default]. Arc coloured from centre for bipolar. */
@Composable
fun Knob(
    label: String,
    description: String,
    valueText: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    default: Float,
    modifier: Modifier = Modifier,
    color: Color = DecksColors.primary,
    size: Dp = 44.dp,
    onChange: (Float) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val current by rememberUpdatedState(value)
    val change by rememberUpdatedState(onChange)
    val span = range.endInclusive - range.start
    Column(modifier.width(size + 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Canvas(
            Modifier
                .size(size)
                .onFocusChanged { focused = it.isFocused }
                .pointerInput(range) {
                    detectDragGestures { ch, drag ->
                        ch.consume()
                        change((current - drag.y / 160f * span + drag.x / 320f * span).coerceIn(range))
                    }
                }
                .pointerInput(default) { detectTapGestures(onDoubleTap = { change(default) }) }
                .rangeControl(description, valueText, value, range, span / 40f, onChange) { onChange(default) },
        ) {
            val stroke = 4.dp.toPx()
            val r = this.size.minDimension / 2 - stroke
            val c = Offset(this.size.width / 2, this.size.height / 2)
            val tl = Offset(c.x - r, c.y - r)
            val arcSize = Size(r * 2, r * 2)
            drawArc(DecksColors.input, 135f, 270f, false, tl, arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
            val frac = ((value - range.start) / span).coerceIn(0f, 1f)
            val zeroFrac = ((default - range.start) / span).coerceIn(0f, 1f)
            val a0 = 135f + 270f * zeroFrac
            val a1 = 135f + 270f * frac
            drawArc(color, minOf(a0, a1), kotlin.math.abs(a1 - a0), false, tl, arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
            drawCircle(if (focused) DecksColors.ring else DecksColors.surfaceRaised, r - stroke * 1.5f, c)
            val ang = (a1 * PI / 180.0)
            val tip = Offset(c.x + cos(ang).toFloat() * (r - stroke * 2), c.y + sin(ang).toFloat() * (r - stroke * 2))
            drawLine(DecksColors.foreground, c, tip, strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
        }
        BasicText(label, style = LocalDecksType.current.label.copy(textAlign = TextAlign.Center), maxLines = 2)
    }
}

/** Linear fader, vertical (channel/tempo) or horizontal (crossfader). Double tap resets. */
@Composable
fun Fader(
    description: String,
    valueText: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    default: Float,
    modifier: Modifier = Modifier,
    vertical: Boolean = true,
    invert: Boolean = false,
    color: Color = DecksColors.primary,
    onChange: (Float) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val change by rememberUpdatedState(onChange)
    val span = range.endInclusive - range.start
    fun fracToValue(f: Float) = range.start + span * (if (invert) 1f - f else f)
    Canvas(
        modifier
            .onFocusChanged { focused = it.isFocused }
            .pointerInput(range, vertical, invert) {
                fun at(o: Offset): Float {
                    val f = if (vertical) 1f - o.y / size.height else o.x / size.width
                    return fracToValue(f.coerceIn(0f, 1f))
                }
                detectDragGestures(onDragStart = { change(at(it)) }) { ch, _ -> ch.consume(); change(at(ch.position)) }
            }
            .pointerInput(default) { detectTapGestures(onDoubleTap = { change(default) }) }
            .rangeControl(description, valueText, value, range, span / 50f, onChange) { onChange(default) },
    ) {
        val track = 4.dp.toPx()
        var f = ((value - range.start) / span).coerceIn(0f, 1f)
        if (invert) f = 1f - f
        val cap = Size(if (vertical) size.width * 0.8f else 14.dp.toPx(), if (vertical) 14.dp.toPx() else size.height * 0.8f)
        if (vertical) {
            val x = size.width / 2
            drawLine(DecksColors.input, Offset(x, 0f), Offset(x, size.height), track, StrokeCap.Round)
            val y = (1f - f) * (size.height - cap.height) + cap.height / 2
            val dy = (1f - ((default - range.start) / span).let { if (invert) 1f - it else it }) * (size.height - cap.height) + cap.height / 2
            drawLine(color, Offset(x, dy), Offset(x, y), track, StrokeCap.Round)
            drawRoundRect(if (focused) DecksColors.ring else DecksColors.foreground, Offset(x - cap.width / 2, y - cap.height / 2), cap,
                androidx.compose.ui.geometry.CornerRadius(3.dp.toPx()))
        } else {
            val y = size.height / 2
            drawLine(DecksColors.input, Offset(0f, y), Offset(size.width, y), track, StrokeCap.Round)
            val x = f * (size.width - cap.width) + cap.width / 2
            drawRoundRect(if (focused) DecksColors.ring else DecksColors.foreground, Offset(x - cap.width / 2, y - cap.height / 2), cap,
                androidx.compose.ui.geometry.CornerRadius(3.dp.toPx()))
        }
    }
}

/** Vertical level meter 0..1 (green → amber → red from tokens). Decorative to TalkBack. */
@Composable
fun VuMeter(level: Float, modifier: Modifier = Modifier) {
    Canvas(modifier.width(6.dp)) {
        val segs = 14
        val gap = 2.dp.toPx()
        val h = (size.height - gap * (segs - 1)) / segs
        val lit = (level.coerceIn(0f, 1f) * segs).toInt()
        for (i in 0 until segs) {
            val y = size.height - (i + 1) * h - i * gap
            val c = when {
                i >= segs - 2 -> DecksColors.danger
                i >= segs - 5 -> DecksColors.warning
                else -> DecksColors.success
            }
            drawRect(if (i < lit) c else DecksColors.input, Offset(0f, y), Size(size.width, h))
        }
    }
}

/** Small labelled value (BPM, key, tempo). */
@Composable
fun Readout(label: String, value: String, modifier: Modifier = Modifier, color: Color = DecksColors.foreground) {
    Column(modifier.semantics(mergeDescendants = true) {}, horizontalAlignment = Alignment.Start) {
        BasicText(label, style = LocalDecksType.current.label)
        BasicText(value, style = LocalDecksType.current.title.copy(color = color), maxLines = 1)
    }
}

/** A layout panel tile. [verticalPad] replaces the look's panel padding above / below (thin strips). */
@Composable
fun Panel(modifier: Modifier = Modifier, verticalPad: Dp? = null, content: @Composable () -> Unit) {
    val skin = LocalDecksSkin.current
    val shape = panelShape(skin)
    // Signature look: flat tiles, no outline (look.css `.panel { border: 0 }`); the classic look keeps its border.
    val outlined = !skin.signature || skin.highContrast
    Box(
        modifier
            .clip(shape)
            .background(DecksColors.surface)
            .then(if (outlined) Modifier.border(1.dp, DecksColors.border, shape) else Modifier)
            .padding(horizontal = skin.panelPadDp.dp, vertical = verticalPad ?: skin.panelPadDp.dp),
    ) { content() }
}

@Composable
fun ButtonRow(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        content()
    }
}

@Composable
fun Spacer(h: Dp) = androidx.compose.foundation.layout.Spacer(Modifier.height(h))
