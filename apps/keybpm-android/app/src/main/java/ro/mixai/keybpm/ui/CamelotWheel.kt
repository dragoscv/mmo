package ro.mixai.keybpm.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.sp
import ro.mixai.mobile.theme.Tokens
import kotlin.math.cos
import kotlin.math.sin

/**
 * Camelot wheel: outer ring = B (major), inner ring = A (minor), 12 o'clock = 12. The detected key glows, compatible
 * keys (same, relative, ±1, energy boost) are drawn at full colour, the rest dimmed. Colours come from the generated
 * design tokens (Tokens.keyMinor / keyMajor); `heat` (24 values, key index order) tints by likelihood while listening.
 * [beatPulse] is read only in the draw phase so the beat animation never recomposes the caller (A51 jank, 2026-11-09);
 * the 24 ring labels are measured once per colour set, not on every frame.
 */
@Composable
fun CamelotWheel(
    camelotNumber: Int?,
    minor: Boolean,
    compatible: Set<String>,
    beatPulse: () -> Float,
    label: String,
    modifier: Modifier = Modifier,
) {
    val measurer = rememberTextMeasurer()
    val onBg = MaterialTheme.colorScheme.onBackground
    val glow by animateFloatAsState(if (camelotNumber != null) 1f else 0f, spring(dampingRatio = 0.6f), label = "glow")
    val ringStyle = remember { TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold) }
    val labels = remember(measurer, onBg) {
        val codes = (0..1).flatMap { ring -> (1..12).map { "$it${if (ring == 1) "A" else "B"}" } }
        codes.associateWith { code ->
            measurer.measure(code, ringStyle.copy(color = onBg.copy(alpha = 0.85f))) to measurer.measure(code, ringStyle.copy(color = Color.Black))
        }
    }
    Box(modifier.aspectRatio(1f).semantics { contentDescription = label }) {
        Canvas(Modifier.fillMaxSize()) {
            val pulse = beatPulse()
            val r = size.minDimension / 2f
            val c = Offset(size.width / 2f, size.height / 2f)
            val seg = 360f / 12f
            for (ring in 0..1) {
                val isMinor = ring == 1
                val outer = if (isMinor) r * 0.68f else r
                val width = r * 0.3f
                val radius = outer - width / 2f
                for (i in 0 until 12) {
                    val number = i + 1
                    val code = "$number${if (isMinor) "A" else "B"}"
                    val base = if (isMinor) Tokens.keyMinor[i] else Tokens.keyMajor[i]
                    val active = camelotNumber == number && minor == isMinor
                    val alpha = when {
                        active -> 1f
                        compatible.contains(code) -> 0.9f
                        camelotNumber == null -> 0.55f
                        else -> 0.18f
                    }
                    // 12 at the top: position n sits at angle (n * 30) - 90 degrees.
                    val start = number * seg - 90f - seg / 2f + 1.5f
                    drawArc(
                        color = base.copy(alpha = alpha),
                        startAngle = start,
                        sweepAngle = seg - 3f,
                        useCenter = false,
                        topLeft = Offset(c.x - radius, c.y - radius),
                        size = Size(radius * 2, radius * 2),
                        style = Stroke(width = if (active) width * (1f + 0.12f * glow + 0.06f * pulse) else width),
                    )
                    val a = Math.toRadians((number * seg - 90f).toDouble())
                    val pair = labels.getValue(code)
                    val t = if (active) pair.second else pair.first
                    drawText(
                        t,
                        topLeft = Offset(
                            c.x + radius * cos(a).toFloat() - t.size.width / 2f,
                            c.y + radius * sin(a).toFloat() - t.size.height / 2f,
                        ),
                    )
                }
            }
            // Beat dot in the centre.
            drawCircle(onBg.copy(alpha = 0.10f + 0.5f * pulse), radius = r * (0.12f + 0.04f * pulse), center = c)
        }
    }
}
