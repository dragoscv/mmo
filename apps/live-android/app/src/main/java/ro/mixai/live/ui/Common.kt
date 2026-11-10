package ro.mixai.live.ui

import android.os.Build
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import ro.mixai.live.R
import ro.mixai.live.core.Role
import ro.mixai.live.core.Throttle
import ro.mixai.mobile.theme.Mixai

fun View.tick(strong: Boolean = false) {
    val c = when {
        strong && Build.VERSION.SDK_INT >= 30 -> HapticFeedbackConstants.REJECT
        strong -> HapticFeedbackConstants.LONG_PRESS
        Build.VERSION.SDK_INT >= 30 -> HapticFeedbackConstants.CONFIRM
        else -> HapticFeedbackConstants.VIRTUAL_KEY
    }
    performHapticFeedback(c)
}

@Composable
fun roleLabel(r: Role): String = stringResource(
    when (r) {
        Role.VIEWER -> R.string.role_viewer
        Role.PERFORMER -> R.string.role_performer
        Role.CONTROLLER -> R.string.role_controller
    },
)

@Composable
fun errorText(code: String, message: String): String = when (code) {
    "forbidden" -> stringResource(R.string.err_forbidden)
    "rate_limited" -> stringResource(R.string.err_rate_limited)
    "no_setlist" -> stringResource(R.string.err_no_setlist)
    "unknown_preset" -> stringResource(R.string.err_unknown_preset)
    else -> stringResource(R.string.err_generic, message.ifBlank { code })
}

@Composable
fun Pill(text: String, color: Color, onColor: Color, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = onColor,
        modifier = modifier.background(color, RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 3.dp),
    )
}

/**
 * Slider bound to an engine value: shows the local drag value while dragging, the engine value otherwise, and sends
 * through a 30 ms leading + trailing [Throttle] (the last value is flushed on release).
 */
@Composable
fun EngineSlider(
    label: String,
    engineValue: Float,
    range: ClosedFloatingPointRange<Float>,
    format: (Float) -> String,
    enabled: Boolean,
    onSend: (Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    var drag by remember { mutableStateOf<Float?>(null) }
    val send by rememberUpdatedState(onSend)
    val throttle = remember { Throttle<Float>(30) { send(it) } }
    val shown = drag ?: engineValue.coerceIn(range.start, range.endInclusive)
    val valueText = format(shown)
    Column(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.labelLarge)
            Text(valueText, style = MaterialTheme.typography.labelMedium, color = Mixai.colors.muted)
        }
        Slider(
            value = shown,
            onValueChange = { v -> drag = v; throttle.offer(v, SystemClock.uptimeMillis()) },
            onValueChangeFinished = { throttle.flush(SystemClock.uptimeMillis()); drag = null },
            valueRange = range,
            enabled = enabled,
            modifier = Modifier.semantics {
                contentDescription = label
                stateDescription = valueText
            },
        )
    }
}
