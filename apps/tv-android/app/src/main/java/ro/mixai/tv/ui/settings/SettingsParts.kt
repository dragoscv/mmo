package ro.mixai.tv.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.LocalContentColor
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import ro.mixai.tv.R
import ro.mixai.tv.ui.components.PinPad
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.components.TvKeyboard
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

// Shared building blocks for Settings, the profile editor and Stats (WP16-27).

/** Section heading inside the details pane. */
@Composable
internal fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = Tokens.brandCyanDark)
        content()
    }
}

/** Full-width focusable row: optional leading icon/composable, title + subtitle, value on the right. */
@Composable
internal fun SettingRow(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    value: String? = null,
    subtitle: String? = null,
    icon: ImageVector? = null,
    leading: (@Composable () -> Unit)? = null,
    enabled: Boolean = true,
    destructive: Boolean = false,
) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().heightIn(min = 52.dp),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(12.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Tokens.foreground.copy(alpha = 0.05f),
            contentColor = if (destructive) Tokens.destructive else Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
            pressedContainerColor = Tokens.foreground,
            pressedContentColor = Tokens.background,
            disabledContainerColor = Tokens.foreground.copy(alpha = 0.03f),
            disabledContentColor = Tokens.mutedForeground,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.02f),
    ) {
        Row(Modifier.padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (leading != null) { leading(); Spacer(Modifier.width(14.dp)) }
            else if (icon != null) { Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp)); Spacer(Modifier.width(14.dp)) }
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                if (!subtitle.isNullOrBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = LocalContentColor.current.copy(alpha = 0.72f), maxLines = 2)
            }
            if (!value.isNullOrBlank()) {
                Spacer(Modifier.width(12.dp))
                Text(value, style = MaterialTheme.typography.bodyMedium, color = LocalContentColor.current.copy(alpha = 0.85f), maxLines = 1)
            }
        }
    }
}

/** On/off row; the value reads "On"/"Off". */
@Composable
internal fun ToggleRow(title: String, checked: Boolean, onToggle: (Boolean) -> Unit, modifier: Modifier = Modifier, subtitle: String? = null, enabled: Boolean = true) {
    SettingRow(
        title = title,
        subtitle = subtitle,
        value = stringResource(if (checked) R.string.set_on else R.string.set_off),
        onClick = { onToggle(!checked) },
        modifier = modifier,
        enabled = enabled,
    )
}

/** Non-interactive "label: value" line used by diagnostics. Focusable so D-pad scrolling reaches it. */
@Composable
internal fun InfoRow(label: String, value: String, modifier: Modifier = Modifier, valueColor: Color = Tokens.foreground) {
    Surface(
        onClick = {},
        modifier = modifier.fillMaxWidth(),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(10.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Color.Transparent,
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground.copy(alpha = 0.10f),
            focusedContentColor = Tokens.foreground,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
            Text(label, style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground, modifier = Modifier.weight(1f))
            Text(value, style = MaterialTheme.typography.bodyMedium, color = valueColor, maxLines = 1)
        }
    }
}

/** Pill option (one of several); the selected one is filled with the accent. */
@Composable
internal fun OptionChip(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier,
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(50)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (selected) Tokens.primary else Tokens.foreground.copy(alpha = 0.08f),
            contentColor = if (selected) Tokens.primaryForeground else Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
            disabledContainerColor = Tokens.foreground.copy(alpha = 0.04f),
            disabledContentColor = Tokens.mutedForeground,
        ),
        border = ClickableSurfaceDefaults.border(
            border = if (selected) Border(BorderStroke(2.dp, Tokens.primary), shape = RoundedCornerShape(50)) else Border.None,
            focusedBorder = Border(BorderStroke(MixaiFocus.ringWidth, Tokens.ring), shape = RoundedCornerShape(50)),
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), maxLines = 1)
    }
}

/** Centered dialog with an on-screen keyboard for short text (profile name, device name). */
@Composable
internal fun TextEntryDialog(title: String, initial: String, onDone: (String) -> Unit, onDismiss: () -> Unit, maxLength: Int = 40) {
    var text by rememberSaveable { mutableStateOf(initial) }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.widthIn(min = 420.dp, max = 560.dp).background(Tokens.popover, RoundedCornerShape(16.dp)).padding(28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(title, style = MaterialTheme.typography.headlineSmall, color = Tokens.popoverForeground)
            Box(
                Modifier.fillMaxWidth().background(Tokens.foreground.copy(alpha = 0.08f), RoundedCornerShape(10.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
            ) {
                Text(
                    text.ifEmpty { stringResource(R.string.set_text_placeholder) },
                    style = MaterialTheme.typography.titleMedium,
                    color = if (text.isEmpty()) Tokens.mutedForeground else Tokens.foreground,
                    maxLines = 1,
                )
            }
            TvKeyboard(text = text, onTextChange = { text = it.trimStart() }, keySize = 44.dp, maxLength = maxLength)
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                PrimaryButton(stringResource(R.string.set_done), { onDone(text.trim()) }, enabled = text.isNotBlank())
                SecondaryButton(stringResource(R.string.wp16_cancel), onDismiss)
            }
        }
    }
}

/** Two-step PIN entry (enter + confirm). Returns the 4-digit PIN through [onDone]. */
@Composable
internal fun PinSetDialog(title: String, onDone: (String) -> Unit, onDismiss: () -> Unit) {
    var first by remember { mutableStateOf<String?>(null) }
    var errorSignal by remember { mutableStateOf(0) }
    var message by remember { mutableStateOf<String?>(null) }
    val mismatch = stringResource(R.string.profile_pin_mismatch)
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.widthIn(min = 380.dp, max = 520.dp).background(Tokens.popover, RoundedCornerShape(16.dp)).padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(title, style = MaterialTheme.typography.headlineSmall, color = Tokens.popoverForeground)
            Text(
                stringResource(if (first == null) R.string.profile_pin_enter_new else R.string.profile_pin_confirm),
                style = MaterialTheme.typography.bodyMedium,
                color = Tokens.mutedForeground,
            )
            // Re-key the pad between steps so the dots reset.
            androidx.compose.runtime.key(first == null) {
                PinPad(
                    errorSignal = errorSignal,
                    message = message,
                    onComplete = { pin ->
                        val f = first
                        when {
                            f == null -> { first = pin; message = null }
                            f == pin -> onDone(pin)
                            else -> { first = null; message = mismatch; errorSignal++ }
                        }
                    },
                )
            }
            SecondaryButton(stringResource(R.string.wp16_cancel), onDismiss)
        }
    }
}

/** Bytes → "12.3 MB". */
internal fun formatBytes(bytes: Long): String = when {
    bytes < 0 -> "—"
    bytes < 1024 -> "$bytes B"
    bytes < 1024L * 1024 -> String.format(java.util.Locale.ROOT, "%.0f KB", bytes / 1024.0)
    bytes < 1024L * 1024 * 1024 -> String.format(java.util.Locale.ROOT, "%.1f MB", bytes / 1024.0 / 1024.0)
    else -> String.format(java.util.Locale.ROOT, "%.2f GB", bytes / 1024.0 / 1024.0 / 1024.0)
}
