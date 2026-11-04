package ro.mixai.tv.ui.components

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.Icon
import androidx.tv.material3.IconButton
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

private val ButtonShape = RoundedCornerShape(10.dp)
private val ButtonPadding = PaddingValues(horizontal = 22.dp, vertical = 10.dp)

/** Filled accent button (main CTA: Play, Resume, Continue). */
@Composable
fun PrimaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        shape = ButtonDefaults.shape(ButtonShape),
        colors = ButtonDefaults.colors(
            containerColor = Tokens.foreground.copy(alpha = 0.14f),
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.primary,
            focusedContentColor = Tokens.primaryForeground,
            pressedContainerColor = Tokens.primary,
            pressedContentColor = Tokens.primaryForeground,
            disabledContainerColor = Tokens.muted,
            disabledContentColor = Tokens.mutedForeground,
        ),
        scale = ButtonDefaults.scale(focusedScale = 1.05f),
        glow = ButtonDefaults.glow(focusedGlow = Glow(MixaiFocus.glowColor, 12.dp)),
        contentPadding = ButtonPadding,
    ) {
        if (icon != null) { Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp)); Spacer(Modifier.width(10.dp)) }
        Text(label, style = MaterialTheme.typography.titleSmall)
    }
}

/** Quiet button (secondary actions: Trailer, Start over, Watchlist). */
@Composable
fun SecondaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        shape = ButtonDefaults.shape(ButtonShape),
        colors = ButtonDefaults.colors(
            containerColor = Tokens.foreground.copy(alpha = 0.08f),
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
            pressedContainerColor = Tokens.foreground,
            pressedContentColor = Tokens.background,
            disabledContainerColor = Tokens.muted,
            disabledContentColor = Tokens.mutedForeground,
        ),
        scale = ButtonDefaults.scale(focusedScale = 1.05f),
        contentPadding = ButtonPadding,
    ) {
        if (icon != null) { Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp)); Spacer(Modifier.width(10.dp)) }
        Text(label, style = MaterialTheme.typography.titleSmall)
    }
}

/** Round icon-only action (player controls, watchlist toggle). [label] is the content description. */
@Composable
fun IconActionButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    enabled: Boolean = true,
) {
    IconButton(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        shape = ButtonDefaults.shape(CircleShape),
        colors = ButtonDefaults.colors(
            containerColor = if (selected) Tokens.primary.copy(alpha = 0.35f) else Tokens.foreground.copy(alpha = 0.10f),
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
            pressedContainerColor = Tokens.foreground,
            pressedContentColor = Tokens.background,
            disabledContainerColor = Tokens.muted,
            disabledContentColor = Tokens.mutedForeground,
        ),
    ) {
        Icon(icon, contentDescription = label, modifier = Modifier.size(24.dp))
    }
}
