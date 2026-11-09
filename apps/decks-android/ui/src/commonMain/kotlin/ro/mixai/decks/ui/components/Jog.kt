package ro.mixai.decks.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import ro.mixai.decks.ui.logic.DeckMath
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalReducedMotion

/**
 * Jog ring: rotates with the playhead (33⅓ rpm) — static marker when reduced motion is on.
 * Circular drag nudges the playhead (±), Left/Right keys nudge by 20 ms.
 */
@Composable
fun JogWheel(
    playheadSec: Double,
    playing: Boolean,
    deckIndex: Int,
    description: String,
    beatInBar: Int,
    modifier: Modifier,
    onNudge: (Double) -> Unit,
) {
    val reduced = LocalReducedMotion.current
    val nudge by rememberUpdatedState(onNudge)
    val angle = if (reduced) 0f else DeckMath.jogAngle(playheadSec)
    Canvas(
        modifier
            .pointerInput(Unit) {
                detectDragGestures { ch, drag ->
                    ch.consume()
                    val c = Offset(size.width / 2f, size.height / 2f)
                    val p = ch.position - c
                    val prev = p - drag
                    var d = atan2(p.y, p.x) - atan2(prev.y, prev.x)
                    if (d > PI) d -= (2 * PI).toFloat()
                    if (d < -PI) d += (2 * PI).toFloat()
                    nudge(d / (2 * PI) * 1.8) // one revolution = 1.8 s (33⅓ rpm)
                }
            }
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onKeyEvent false
                when (e.key) {
                    Key.DirectionLeft -> { nudge(-0.02); true }
                    Key.DirectionRight -> { nudge(0.02); true }
                    else -> false
                }
            }
            .focusable()
            .semantics { contentDescription = description },
    ) {
        val stroke = 6.dp.toPx()
        val r = size.minDimension / 2 - stroke
        val c = Offset(size.width / 2, size.height / 2)
        val deck = DecksColors.deck(deckIndex)
        drawCircle(DecksColors.surfaceRaised, r, c)
        drawCircle(DecksColors.border, r, c, style = Stroke(1.dp.toPx()))
        // Beat segments (4 per bar) light up around the ring.
        for (i in 0 until 4) {
            val lit = i == beatInBar && playing
            drawArc(
                if (lit) deck else DecksColors.input,
                -90f + i * 90f + 4f, 82f, false,
                Offset(c.x - r, c.y - r), Size(r * 2, r * 2),
                style = Stroke(stroke, cap = StrokeCap.Butt),
            )
        }
        rotate(angle, c) {
            drawLine(deck, c, Offset(c.x, c.y - r + stroke), strokeWidth = 3.dp.toPx(), cap = StrokeCap.Round)
        }
        drawCircle(DecksColors.background, r * 0.28f, c)
    }
}

/**
 * Phase meter: the deck's beat offset against the master clock (-½..+½ beat); centre = in phase.
 */
@Composable
fun PhaseMeter(offsetBeats: Double?, deckIndex: Int, description: String, modifier: Modifier) {
    Canvas(modifier.semantics { contentDescription = description }) {
        val mid = size.width / 2
        drawRect(DecksColors.surfaceRaised)
        drawLine(DecksColors.border, Offset(mid, 0f), Offset(mid, size.height), 1f)
        if (offsetBeats == null) return@Canvas
        val x = mid + (offsetBeats * 2 * mid).toFloat()
        val ok = abs(offsetBeats) < 0.03
        val w = 10.dp.toPx()
        drawRect(if (ok) DecksColors.success else DecksColors.deck(deckIndex), Offset(x - w / 2, 0f), Size(w, size.height))
    }
}
