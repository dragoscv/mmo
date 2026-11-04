package ro.mixai.tv.player

import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp
import ro.mixai.tv.ui.theme.Tokens

// Player-only glyphs missing from material-icons-core and MixaiIcons (Material Symbols paths, Apache-2.0).
internal object PlayerIcons {
    /** Sleep timer. */
    val Bedtime: ImageVector by lazy {
        icon("Bedtime", "M12.34 2.02C6.59 1.82 2 6.42 2 12c0 5.52 4.48 10 10 10 3.71 0 6.93-2.02 8.66-5.02-7.51-.25-12.09-8.43-8.32-14.96z")
    }

    private fun icon(name: String, d: String): ImageVector =
        ImageVector.Builder(name = "Player.$name", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
            .addPath(pathData = PathParser().parsePathString(d).toNodes(), fill = SolidColor(Tokens.foreground))
            .build()
}
