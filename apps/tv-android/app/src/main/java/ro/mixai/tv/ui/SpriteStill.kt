package ro.mixai.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import coil3.compose.AsyncImagePainter
import ro.mixai.tv.ui.theme.Tokens

private const val GRID = 12

/**
 * Shows ONE tile of the server's scrubber sprite (`/video/thumbs/:fileId/sprite.jpg`,
 * a 12×12 grid of 160×90 tiles) as a 16:9 still. The whole sprite is loaded with Coil and
 * scaled ×12 with a graphics layer, translated so the wanted tile fills the clipped box.
 * Tile 14 (col 2, row 1 ≈ 10 % into the film) avoids black intros. On loading/error/503
 * the title is shown on the card colour instead.
 */
@Composable
fun SpriteStill(url: String, title: String, modifier: Modifier = Modifier, tileIndex: Int = 14) {
    var ok by remember(url) { mutableStateOf(false) }
    val col = tileIndex % GRID
    val row = tileIndex / GRID
    Box(modifier.clipToBounds().background(Tokens.card)) {
        AsyncImage(
            model = url,
            contentDescription = null,
            contentScale = ContentScale.FillBounds,
            onState = { s -> ok = s is AsyncImagePainter.State.Success },
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer {
                    transformOrigin = TransformOrigin(0f, 0f)
                    scaleX = GRID.toFloat()
                    scaleY = GRID.toFloat()
                    translationX = -col * size.width
                    translationY = -row * size.height
                },
        )
        if (!ok) {
            Box(Modifier.fillMaxSize().background(Tokens.card).padding(16.dp), contentAlignment = Alignment.BottomStart) {
                Text(title, color = Tokens.foreground, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
