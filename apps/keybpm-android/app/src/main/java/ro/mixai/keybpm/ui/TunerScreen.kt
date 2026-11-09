package ro.mixai.keybpm.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ro.mixai.keybpm.ListenUi
import ro.mixai.keybpm.R
import ro.mixai.mobile.theme.Mixai
import kotlin.math.abs
import kotlin.math.roundToInt

/** Chromatic tuner on the same engine: note + cents needle, adjustable A4 reference (415..466 Hz). */
@Composable
fun TunerScreen(
    ui: ListenUi,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onA4: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val p = ui.snapshot?.pitch
    val cents by animateFloatAsState((p?.cents ?: 0.0).toFloat(), label = "cents")
    val inTune = p != null && abs(p.cents) < 5
    val color = if (inTune) Mixai.colors.success else MaterialTheme.colorScheme.primary
    Column(
        modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            p?.noteName ?: "—",
            fontSize = 72.sp,
            fontWeight = FontWeight.Bold,
            color = color,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        Text(
            p?.let { "%+d ¢ · %.1f Hz".format(it.cents.roundToInt(), it.hz) } ?: stringResource(R.string.tuner_hint),
            color = Mixai.colors.muted,
        )
        Spacer(Modifier.height(24.dp))
        Canvas(Modifier.fillMaxWidth().height(80.dp)) {
            val mid = size.width / 2f
            for (c in -50..50 step 10) {
                val x = mid + c / 50f * (size.width / 2f - 8f)
                val tall = c == 0
                drawLine(
                    color.copy(alpha = if (tall) 0.9f else 0.35f),
                    Offset(x, if (tall) 0f else size.height * 0.35f),
                    Offset(x, size.height),
                    strokeWidth = if (tall) 4f else 2f,
                )
            }
            val nx = mid + cents.coerceIn(-50f, 50f) / 50f * (size.width / 2f - 8f)
            if (p != null) drawLine(color, Offset(nx, 0f), Offset(nx, size.height), strokeWidth = 10f, cap = StrokeCap.Round)
        }
        Spacer(Modifier.height(24.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = { onA4(ui.a4 - 1) }) { Text("−") }
            Text(stringResource(R.string.tuner_reference, ui.a4))
            OutlinedButton(onClick = { onA4(ui.a4 + 1) }) { Text("+") }
        }
        Spacer(Modifier.height(24.dp))
        if (ui.listening) Button(onClick = onStop) { Text(stringResource(R.string.listen_stop)) }
        else Button(onClick = onStart) { Text(stringResource(R.string.listen_start)) }
    }
}
