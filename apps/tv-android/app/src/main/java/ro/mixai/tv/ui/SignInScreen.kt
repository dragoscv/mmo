package ro.mixai.tv.ui

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import ro.mixai.tv.BuildConfig
import ro.mixai.tv.R
import ro.mixai.tv.data.CompanionServer
import ro.mixai.tv.data.DeviceAuth
import ro.mixai.tv.data.DeviceAuthException
import ro.mixai.tv.data.DeviceCode
import ro.mixai.tv.data.DeviceTokenOk
import ro.mixai.tv.data.TokenResult
import ro.mixai.tv.ui.theme.Tokens

private sealed interface SignInState {
    data object Requesting : SignInState
    data class Waiting(val code: DeviceCode, val expiresAt: Long) : SignInState
    data class Connecting(val body: DeviceTokenOk) : SignInState
    data object Expired : SignInState
    data object Denied : SignInState
    /** `error` is a DeviceAuthException (localised by kind) or any other Throwable (message shown raw). */
    data class Failed(val error: Throwable) : SignInState
}

/**
 * MixAI account sign-in: shows the 8-char user code + QR of `verification_uri_complete`,
 * polls `/api/device/token` at `interval` (+5 s on slow_down), then probes the returned
 * companions (`lanUrl` → `apiUrl`, `/health`, 2 s) and reports the first reachable one.
 */
@Composable
fun SignInScreen(
    onSignedIn: (body: DeviceTokenOk, picked: Pair<CompanionServer, String>?) -> Unit,
    onBack: () -> Unit,
) {
    val auth = remember { DeviceAuth() }
    var state by remember { mutableStateOf<SignInState>(SignInState.Requesting) }
    var secondsLeft by remember { mutableIntStateOf(0) }
    var attempt by remember { mutableIntStateOf(0) }
    val primaryFocus = remember { FocusRequester() }
    val deviceName = remember { "${Build.MODEL} · MixAI TV" }

    LaunchedEffect(attempt) {
        state = SignInState.Requesting
        val code = try { auth.requestCode(deviceName, BuildConfig.VERSION_NAME) } catch (e: Exception) {
            state = SignInState.Failed(e); return@LaunchedEffect
        }
        val expiresAt = System.currentTimeMillis() + code.expires_in * 1000
        state = SignInState.Waiting(code, expiresAt)
        var interval = code.interval.coerceAtLeast(1) * 1000
        while (true) {
            val left = ((expiresAt - System.currentTimeMillis()) / 1000).toInt()
            secondsLeft = left.coerceAtLeast(0)
            if (left <= 0) { state = SignInState.Expired; return@LaunchedEffect }
            try {
                when (val r = auth.pollToken(code.device_code)) {
                    is TokenResult.Ok -> { state = SignInState.Connecting(r.body); return@LaunchedEffect }
                    TokenResult.Expired -> { state = SignInState.Expired; return@LaunchedEffect }
                    TokenResult.AccessDenied -> { state = SignInState.Denied; return@LaunchedEffect }
                    TokenResult.SlowDown -> interval += 5_000
                    TokenResult.Pending -> {}
                }
            } catch (e: DeviceAuthException) {
                // Endpoint gone (404/5xx) → surface it; status 0 = transient network, keep polling.
                if (e.status != 0) { state = SignInState.Failed(e); return@LaunchedEffect }
            } catch (_: Exception) { /* transient */ }
            // Tick the countdown once a second while waiting for the next poll.
            var waited = 0L
            while (waited < interval) {
                delay(1_000); waited += 1_000
                secondsLeft = ((expiresAt - System.currentTimeMillis()) / 1000).toInt().coerceAtLeast(0)
            }
        }
    }

    LaunchedEffect(state) {
        val s = state
        if (s is SignInState.Connecting) onSignedIn(s.body, auth.pickReachable(s.body.companions))
        if (s is SignInState.Expired || s is SignInState.Failed || s is SignInState.Denied) { delay(50); runCatching { primaryFocus.requestFocus() } }
    }

    Box(Modifier.fillMaxSize().padding(64.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text(stringResource(R.string.signin_title), style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground)
            Text(stringResource(R.string.signin_open, auth.host), color = Tokens.mutedForeground)

            when (val s = state) {
                SignInState.Requesting -> Text(stringResource(R.string.signin_requesting, auth.host), color = Tokens.mutedForeground)
                is SignInState.Connecting -> Text(stringResource(R.string.signin_connecting, s.body.user.name ?: s.body.user.id), color = Tokens.mutedForeground)
                is SignInState.Waiting -> {
                    Row(horizontalArrangement = Arrangement.spacedBy(48.dp), verticalAlignment = Alignment.CenterVertically) {
                        QrCode(content = s.code.verification_uri_complete.ifBlank { s.code.verification_uri }, modifier = Modifier.size(260.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(stringResource(R.string.signin_your_code), color = Tokens.mutedForeground)
                            Text(
                                s.code.user_code,
                                fontSize = 84.sp, fontWeight = FontWeight.Bold, color = Tokens.brandCyanDark, letterSpacing = 6.sp,
                            )
                            Text(stringResource(R.string.signin_scan), color = Tokens.foreground)
                            Text(
                                if (secondsLeft > 0) stringResource(R.string.signin_expires_in, secondsLeft / 60, secondsLeft % 60)
                                else stringResource(R.string.signin_waiting),
                                color = Tokens.mutedForeground,
                            )
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = onBack) { Text(stringResource(R.string.action_back)) }
                }
                SignInState.Expired -> {
                    Text(stringResource(R.string.signin_expired), color = Tokens.warning, style = MaterialTheme.typography.titleLarge)
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Button(onClick = { attempt++ }, modifier = Modifier.focusRequester(primaryFocus)) { Text(stringResource(R.string.signin_new_code)) }
                        Button(onClick = onBack) { Text(stringResource(R.string.action_back)) }
                    }
                }
                SignInState.Denied -> {
                    Text(stringResource(R.string.signin_denied), color = Tokens.destructive, style = MaterialTheme.typography.titleLarge)
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Button(onClick = { attempt++ }, modifier = Modifier.focusRequester(primaryFocus)) { Text(stringResource(R.string.action_retry)) }
                        Button(onClick = onBack) { Text(stringResource(R.string.action_back)) }
                    }
                }
                is SignInState.Failed -> {
                    Text(authErrorText(s.error), color = Tokens.destructive, style = MaterialTheme.typography.titleLarge)
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Button(onClick = { attempt++ }, modifier = Modifier.focusRequester(primaryFocus)) { Text(stringResource(R.string.action_retry)) }
                        Button(onClick = onBack) { Text(stringResource(R.string.action_back)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun authErrorText(e: Throwable): String = when (e) {
    is DeviceAuthException -> when (e.kind) {
        DeviceAuthException.Kind.Network -> stringResource(R.string.signin_err_network, e.host)
        DeviceAuthException.Kind.Status -> stringResource(R.string.signin_err_status, e.host, e.status)
        DeviceAuthException.Kind.Invalid -> stringResource(R.string.signin_err_invalid, e.host)
    }
    else -> e.message ?: e.javaClass.simpleName
}
