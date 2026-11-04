package ro.mixai.tv.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

/** Screen title at the overscan-safe top-left. */
@Composable
fun ScreenTitle(title: String, modifier: Modifier = Modifier, subtitle: String? = null) {
    Column(modifier.padding(start = MixaiFocus.overscan, end = MixaiFocus.overscan, top = MixaiFocus.overscanTop), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.headlineLarge, color = Tokens.foreground)
        if (!subtitle.isNullOrBlank()) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
    }
}

/**
 * Placeholder layout used by screens that are not built yet: title + a centered [EmptyState].
 * Screen implementations replace the body; keep the public screen signature.
 */
@Composable
fun PlaceholderScreen(title: String, icon: ImageVector, message: String, action: (@Composable (Modifier) -> Unit)? = null) {
    Column(Modifier.fillMaxSize()) {
        ScreenTitle(title)
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            EmptyState(icon = icon, title = title, message = message, action = action)
        }
    }
}
