package ro.mixai.tv.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.ui.theme.Tokens

private val LETTERS = listOf(
    "abcdefg".map { it.toString() },
    "hijklmn".map { it.toString() },
    "opqrstu".map { it.toString() },
    "vwxyz12".map { it.toString() },
    "3456789".map { it.toString() },
)
private val DIACRITICS = listOf("ă", "â", "î", "ș", "ț", "0", "-")

private const val K_SPACE = "␣"
private const val K_BACK = "⌫"
private const val K_CLEAR = "clear"
private const val K_RO = "ro"

/**
 * D-pad on-screen keyboard (a–z, 0–9, space, backspace, clear) with a Romanian diacritics row
 * toggle (ă â î ș ț). Emits the whole text through [onTextChange]. Hardware/remote keyboards also
 * type into it. [requestInitialFocus] focuses the "a" key on first composition.
 */
@Composable
fun TvKeyboard(
    text: String,
    onTextChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    keySize: Dp = 52.dp,
    requestInitialFocus: Boolean = true,
    maxLength: Int = 100,
    focusRequester: FocusRequester = remember { FocusRequester() },
) {
    var diacritics by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) { if (requestInitialFocus) { delay(50); runCatching { focusRequester.requestFocus() } } }

    fun emit(s: String) { onTextChange(s.take(maxLength)) }
    fun press(k: String) = when (k) {
        K_SPACE -> emit("$text ")
        K_BACK -> emit(text.dropLast(1))
        K_CLEAR -> emit("")
        K_RO -> diacritics = !diacritics
        else -> emit(text + k)
    }

    Column(
        modifier.onPreviewKeyEvent { e ->
            if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            when {
                e.key == Key.Backspace || e.key == Key.Delete -> { press(K_BACK); true }
                e.key == Key.Spacebar -> { press(K_SPACE); true }
                else -> {
                    val cp = e.utf16CodePoint
                    if (cp > 32 && cp != 127 && !isDpad(e.key)) { emit(text + cp.toChar().lowercaseChar()); true } else false
                }
            }
        },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val rows = if (diacritics) listOf(DIACRITICS) + LETTERS else LETTERS
        rows.forEachIndexed { r, row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEachIndexed { c, k ->
                    val m = if (r == (if (diacritics) 1 else 0) && c == 0) Modifier.focusRequester(focusRequester) else Modifier
                    KeyCap(k, keySize, keySize, m) { press(k) }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val wide = keySize * 2 + 8.dp
            KeyCap(K_SPACE, wide + keySize + 8.dp, keySize) { press(K_SPACE) }
            KeyCap(K_BACK, wide, keySize) { press(K_BACK) }
            KeyCap(K_CLEAR, keySize * 1.5f, keySize) { press(K_CLEAR) }
            KeyCap(K_RO, keySize, keySize, selected = diacritics) { press(K_RO) }
        }
    }
}

private fun isDpad(k: Key) = k == Key.DirectionUp || k == Key.DirectionDown || k == Key.DirectionLeft || k == Key.DirectionRight ||
    k == Key.DirectionCenter || k == Key.Enter || k == Key.Back || k == Key.Tab

@Composable
private fun KeyCap(k: String, w: Dp, h: Dp, modifier: Modifier = Modifier, selected: Boolean = false, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = modifier.width(w).height(h),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(10.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (selected) Tokens.primary.copy(alpha = 0.4f) else Tokens.foreground.copy(alpha = 0.08f),
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.1f),
    ) {
        Box(Modifier.width(w).height(h), contentAlignment = Alignment.Center) {
            when (k) {
                K_BACK -> Icon(MixaiIcons.Backspace, contentDescription = stringResource(R.string.wp16_key_backspace), modifier = Modifier.size(22.dp))
                K_SPACE -> Text(stringResource(R.string.wp16_key_space), style = MaterialTheme.typography.labelMedium)
                K_CLEAR -> Text(stringResource(R.string.wp16_key_clear), style = MaterialTheme.typography.labelMedium)
                K_RO -> Text(stringResource(R.string.wp16_key_diacritics), style = MaterialTheme.typography.labelMedium)
                else -> Text(k, style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}
