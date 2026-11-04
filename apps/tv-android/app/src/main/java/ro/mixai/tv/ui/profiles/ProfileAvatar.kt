package ro.mixai.tv.ui.profiles

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import ro.mixai.tv.data.generated.Profile
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.theme.Tokens

/**
 * Profile colour from the server `color` field. Named colours map onto design tokens; anything
 * else (or null) picks a stable token colour from the profile id — never a hand-typed colour.
 */
fun profileColor(p: Profile?): Color {
    val palette = listOf(Tokens.chart1, Tokens.chart2, Tokens.chart3, Tokens.chart4, Tokens.chart5, Tokens.brandDeckB, Tokens.brandDeckD)
    return when (p?.color?.lowercase()) {
        "violet", "purple" -> Tokens.brandViolet
        "magenta", "pink" -> Tokens.brandMagenta
        "cyan", "teal" -> Tokens.brandCyan
        "emerald", "green" -> Tokens.success
        "amber", "orange", "yellow" -> Tokens.warning
        "rose", "red" -> Tokens.destructive
        "blue" -> Tokens.info
        else -> palette[((p?.id ?: "").hashCode() and 0x7fffffff) % palette.size]
    }
}

/**
 * Round avatar: image when `avatar` is an http(s) URL, else the initial on a token gradient.
 * [showKidBadge] adds the kids glyph at the bottom-right.
 */
@Composable
fun ProfileAvatar(profile: Profile?, size: Dp = 120.dp, modifier: Modifier = Modifier, showKidBadge: Boolean = false) {
    val c = profileColor(profile)
    Box(modifier.size(size)) {
        Box(
            Modifier.fillMaxSize().clip(CircleShape).background(Brush.linearGradient(listOf(c, c.copy(alpha = 0.55f)))),
            contentAlignment = Alignment.Center,
        ) {
            val av = profile?.avatar
            if (profile == null) {
                Icon(Icons.Filled.Person, contentDescription = null, tint = Tokens.background, modifier = Modifier.fillMaxSize().padding(size * 0.18f))
            } else if (av != null && (av.startsWith("http://") || av.startsWith("https://"))) {
                AsyncImage(av, contentDescription = profile.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            } else {
                val initial = profile.name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"
                Text(initial, style = TextStyle(fontSize = (size.value * 0.42f).sp, fontWeight = FontWeight.Bold, color = Tokens.background))
            }
        }
        if (showKidBadge) {
            Box(
                Modifier.align(Alignment.BottomEnd).offset(x = 2.dp, y = 2.dp).size(size * 0.36f).clip(CircleShape).background(Tokens.warning).padding(size * 0.05f),
                contentAlignment = Alignment.Center,
            ) {
                Icon(MixaiIcons.Kids, contentDescription = null, tint = Tokens.background, modifier = Modifier.fillMaxSize())
            }
        }
    }
}
