package ro.mixai.tv.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.keyframes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.ui.theme.Tokens
import kotlin.math.roundToInt

/**
 * 4-digit PIN entry: dots + on-screen 3×4 keypad (1-9, ⌫, 0, clear). Remote number keys
 * (`Key.Zero..Nine`) and Backspace/Del work too. Calls [onComplete] with the PIN when the 4th
 * digit is entered; bump [errorSignal] (e.g. a counter) to shake + clear after a wrong PIN.
 */
@Composable
fun PinPad(
    onComplete: (String) -> Unit,
    modifier: Modifier = Modifier,
    length: Int = 4,
    errorSignal: Int = 0,
    enabled: Boolean = true,
    message: String? = null,
) {
    var pin by rememberSaveable { mutableStateOf("") }
    val shake = remember { Animatable(0f) }
    val first = remember { FocusRequester() }

    LaunchedEffect(Unit) { delay(50); runCatching { first.requestFocus() } }
    LaunchedEffect(errorSignal) {
        if (errorSignal == 0) return@LaunchedEffect
        shake.animateTo(0f, keyframes {
            durationMillis = 360
            -18f at 45; 18f at 110; -12f at 175; 12f at 240; -6f at 300; 0f at 360
        })
        pin = ""
    }

    fun type(d: Char) {
        if (!enabled || pin.length >= length) return
        pin += d
        if (pin.length == length) onComplete(pin)
    }
    fun back() { if (pin.isNotEmpty()) pin = pin.dropLast(1) }

    Column(
        modifier.onPreviewKeyEvent { e ->
            if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            val digit = digitOf(e.key)
            when {
                digit != null -> { type(digit); true }
                e.key == Key.Backspace || e.key == Key.Delete -> { back(); true }
                else -> false
            }
        },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        Row(Modifier.offset { IntOffset(shake.value.roundToInt(), 0) }, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
            repeat(length) { i ->
                val filled = i < pin.length
                Box(
                    Modifier.size(22.dp).let {
                        if (filled) it.background(if (errorSignal > 0 && shake.isRunning) Tokens.destructive else Tokens.foreground, CircleShape)
                        else it.border(2.dp, Tokens.mutedForeground, CircleShape)
                    },
                )
            }
        }
        if (!message.isNullOrBlank()) Text(message, style = MaterialTheme.typography.bodyMedium, color = Tokens.destructive)
        val rows = listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("C", "0", "<"))
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            rows.forEachIndexed { r, row ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    row.forEachIndexed { c, k ->
                        val m = if (r == 0 && c == 0) Modifier.focusRequester(first) else Modifier
                        PinKey(k, m, enabled) {
                            when (k) {
                                "<" -> back()
                                "C" -> pin = ""
                                else -> type(k[0])
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PinKey(k: String, modifier: Modifier, enabled: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.size(76.dp, 60.dp),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(12.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Tokens.foreground.copy(alpha = 0.08f),
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.08f),
    ) {
        Box(Modifier.size(76.dp, 60.dp), contentAlignment = Alignment.Center) {
            when (k) {
                "<" -> Icon(MixaiIcons.Backspace, contentDescription = stringResource(R.string.wp16_key_backspace), modifier = Modifier.size(26.dp))
                "C" -> Text(stringResource(R.string.wp16_key_clear), style = MaterialTheme.typography.labelMedium)
                else -> Text(k, style = MaterialTheme.typography.headlineSmall)
            }
        }
    }
}

private fun digitOf(k: Key): Char? = when (k) {
    Key.Zero, Key.NumPad0 -> '0'
    Key.One, Key.NumPad1 -> '1'
    Key.Two, Key.NumPad2 -> '2'
    Key.Three, Key.NumPad3 -> '3'
    Key.Four, Key.NumPad4 -> '4'
    Key.Five, Key.NumPad5 -> '5'
    Key.Six, Key.NumPad6 -> '6'
    Key.Seven, Key.NumPad7 -> '7'
    Key.Eight, Key.NumPad8 -> '8'
    Key.Nine, Key.NumPad9 -> '9'
    else -> null
}
