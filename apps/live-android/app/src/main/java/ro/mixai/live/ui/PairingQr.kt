package ro.mixai.live.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * Pairing QR for the phone engine's LAN mode (same payload as the desktop: the web-remote URL with the token; the
 * Live apps' scanners and any browser accept it). Black on white on purpose: scanners need maximum contrast.
 */
@Composable
fun PairingQr(content: String, description: String, modifier: Modifier = Modifier) {
    val matrix: BitMatrix? = remember(content) {
        runCatching {
            QRCodeWriter().encode(
                content, BarcodeFormat.QR_CODE, 0, 0,
                mapOf(EncodeHintType.MARGIN to 1, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M),
            )
        }.getOrNull()
    }
    Box(modifier.background(Color.White).padding(8.dp).semantics { contentDescription = description }) {
        if (matrix != null) Canvas(Modifier.fillMaxSize()) {
            val cell = size.minDimension / matrix.width
            val ox = (size.width - cell * matrix.width) / 2
            val oy = (size.height - cell * matrix.height) / 2
            for (y in 0 until matrix.height) for (x in 0 until matrix.width) {
                if (matrix.get(x, y)) drawRect(Color.Black, Offset(ox + x * cell, oy + y * cell), Size(cell, cell))
            }
        }
    }
}
