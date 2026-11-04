package ro.mixai.tv.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import ro.mixai.tv.R
import ro.mixai.tv.ui.theme.Tokens

/** Outlined (age rating, format) or filled metadata chip. Not focusable. */
@Composable
fun MetaChip(text: String, modifier: Modifier = Modifier, outlined: Boolean = false) {
    val shape = RoundedCornerShape(6.dp)
    val m = if (outlined) modifier.clip(shape).border(1.dp, Tokens.foreground.copy(alpha = 0.6f), shape)
    else modifier.clip(shape).background(Tokens.foreground.copy(alpha = 0.12f))
    Text(text, style = MaterialTheme.typography.labelMedium, color = Tokens.foreground, maxLines = 1, modifier = m.padding(horizontal = 8.dp, vertical = 3.dp))
}

/** Dot-separated metadata line: year · age · runtime · formats (e.g. 4K, HDR, DV, 5.1). */
@Composable
fun MetaChips(
    modifier: Modifier = Modifier,
    year: String? = null,
    age: String? = null,
    runtimeMin: Long? = null,
    formats: List<String> = emptyList(),
    rating: Double? = null,
) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        if (!year.isNullOrBlank()) Text(year, style = MaterialTheme.typography.bodyMedium, color = Tokens.foreground)
        if (rating != null && rating > 0) Text(stringResource(R.string.wp16_rating, rating), style = MaterialTheme.typography.bodyMedium, color = Tokens.foreground)
        if (!age.isNullOrBlank()) MetaChip(age, outlined = true)
        if (runtimeMin != null && runtimeMin > 0) Text(formatRuntime(runtimeMin), style = MaterialTheme.typography.bodyMedium, color = Tokens.foreground)
        formats.forEach { MetaChip(it) }
    }
}

/** `95` → "1 h 35 min" (localised). */
@Composable
fun formatRuntime(minutes: Long): String {
    val h = minutes / 60
    val m = minutes % 60
    return when {
        h == 0L -> stringResource(R.string.wp16_runtime_min, m)
        m == 0L -> stringResource(R.string.wp16_runtime_h, h)
        else -> stringResource(R.string.wp16_runtime_hm, h, m)
    }
}
