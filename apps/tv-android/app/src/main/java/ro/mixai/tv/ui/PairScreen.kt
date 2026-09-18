package ro.mixai.tv.ui

import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.data.DiscoveredServer
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.PairRequest
import ro.mixai.tv.ui.theme.Tokens

private sealed interface PairState {
    data object Requesting : PairState
    data class Waiting(val req: PairRequest) : PairState
    data object Expired : PairState
    data class Failed(val message: String?) : PairState
}

/**
 * Step 2 of Quick Connect: `POST /pair/request`, show the 6-digit code + QR of
 * `approveUrl`, poll `/pair/poll` every 3 s until approved/expired.
 */
@Composable
fun PairScreen(server: DiscoveredServer, onPaired: (baseUrl: String, token: String, userId: String) -> Unit, onBack: () -> Unit) {
    val api = remember(server.baseUrl) { MmoApi(server.baseUrl, "") }
    var state by remember { mutableStateOf<PairState>(PairState.Requesting) }
    var secondsLeft by remember { mutableIntStateOf(0) }
    var attempt by remember { mutableIntStateOf(0) }
    val retryFocus = remember { FocusRequester() }
    val deviceName = remember { "${Build.MODEL} · MixAI TV" }

    LaunchedEffect(attempt) {
        state = PairState.Requesting
        val req = try { api.pairRequest(deviceName) } catch (e: Exception) {
            state = PairState.Failed(e.message ?: e.javaClass.simpleName); return@LaunchedEffect
        }
        state = PairState.Waiting(req)
        while (true) {
            val left = ((req.expiresAt - System.currentTimeMillis()) / 1000).toInt()
            secondsLeft = left.coerceAtLeast(0)
            if (req.expiresAt > 0 && left <= 0) { state = PairState.Expired; return@LaunchedEffect }
            try {
                val poll = api.pairPoll(req.code, req.secret)
                when (poll.status) {
                    "approved" -> {
                        val token = poll.deviceToken
                        if (token.isNullOrBlank()) state = PairState.Failed(null) // → pair_err_no_token
                        else onPaired(server.baseUrl, token, poll.userId ?: "")
                        return@LaunchedEffect
                    }
                    "expired" -> { state = PairState.Expired; return@LaunchedEffect }
                }
            } catch (_: Exception) { /* transient; keep polling */ }
            delay(3_000)
        }
    }

    LaunchedEffect(state) {
        if (state is PairState.Expired || state is PairState.Failed) { delay(50); runCatching { retryFocus.requestFocus() } }
    }

    Box(Modifier.fillMaxSize().padding(64.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text(stringResource(R.string.pair_title, server.name.ifBlank { server.host }), style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground)
            Text("${server.host}:${server.port}", color = Tokens.mutedForeground)

            when (val s = state) {
                PairState.Requesting -> Text(stringResource(R.string.pair_requesting), color = Tokens.mutedForeground)
                is PairState.Waiting -> {
                    Row(horizontalArrangement = Arrangement.spacedBy(48.dp), verticalAlignment = Alignment.CenterVertically) {
                        QrCode(content = s.req.approveUrl.ifBlank { s.req.qr }, modifier = Modifier.size(260.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(stringResource(R.string.common_your_code), color = Tokens.mutedForeground)
                            Text(
                                s.req.code.chunked(3).joinToString(" "),
                                fontSize = 84.sp, fontWeight = FontWeight.Bold, color = Tokens.brandCyanDark, letterSpacing = 6.sp,
                            )
                            Text(stringResource(R.string.pair_scan), color = Tokens.foreground)
                            Text(
                                if (secondsLeft > 0) stringResource(R.string.common_expires_in, secondsLeft / 60, secondsLeft % 60)
                                else stringResource(R.string.pair_waiting),
                                color = Tokens.mutedForeground,
                            )
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = onBack) { Text(stringResource(R.string.action_back)) }
                }
                PairState.Expired -> {
                    Text(stringResource(R.string.pair_expired), color = Tokens.warning, style = MaterialTheme.typography.titleLarge)
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Button(onClick = { attempt++ }, modifier = Modifier.focusRequester(retryFocus)) { Text(stringResource(R.string.action_retry)) }
                        Button(onClick = onBack) { Text(stringResource(R.string.action_back)) }
                    }
                }
                is PairState.Failed -> {
                    Text(stringResource(R.string.connect_fail, s.message ?: stringResource(R.string.pair_err_no_token)), color = Tokens.destructive)
                    Text(stringResource(R.string.pair_failed_hint), color = Tokens.mutedForeground)
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Button(onClick = { attempt++ }, modifier = Modifier.focusRequester(retryFocus)) { Text(stringResource(R.string.action_retry)) }
                        Button(onClick = onBack) { Text(stringResource(R.string.action_back)) }
                    }
                }
            }
        }
    }
}

/** Renders `content` as a QR code with ZXing's BitMatrix + Compose Canvas (no bitmaps, no camera). */
@Composable
fun QrCode(content: String, modifier: Modifier = Modifier) {
    val matrix: BitMatrix? = remember(content) {
        if (content.isBlank()) null else try {
            QRCodeWriter().encode(
                content, BarcodeFormat.QR_CODE, 0, 0,
                mapOf(EncodeHintType.MARGIN to 1, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M),
            )
        } catch (_: Exception) { null }
    }
    Box(modifier.background(Color.White).padding(12.dp)) {
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
