package ro.mixai.tv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import ro.mixai.tv.ui.theme.Tokens

enum class EmptyTone { Normal, Error }

/** Empty / error placeholder: emoji glyph, title, optional message and optional action slot. */
@Composable
fun EmptyState(
    icon: String,
    title: String,
    message: String? = null,
    modifier: Modifier = Modifier,
    tone: EmptyTone = EmptyTone.Normal,
    action: (@Composable () -> Unit)? = null,
) {
    Column(modifier.padding(horizontal = 56.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.Start) {
        Text(icon, fontSize = 32.sp)
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            color = if (tone == EmptyTone.Error) Tokens.destructive else Tokens.foreground,
        )
        if (!message.isNullOrBlank()) Text(message, color = Tokens.mutedForeground, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Start)
        if (action != null) { Spacer(Modifier.height(8.dp)); action() }
    }
}
