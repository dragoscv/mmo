package ro.mixai.app.ui.onboarding

import android.content.Context
import android.net.Uri
import android.os.Build
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.app.BuildConfig
import ro.mixai.app.MixaiPhoneApp
import ro.mixai.app.R
import ro.mixai.app.auth.GoogleSignIn
import ro.mixai.app.auth.GoogleSignInResult
import ro.mixai.app.ui.components.QrCode
import ro.mixai.app.ui.components.errorText
import ro.mixai.tv.data.CompanionServer
import ro.mixai.tv.data.DeviceAuth
import ro.mixai.tv.data.DeviceAuthException
import ro.mixai.tv.data.DeviceCode
import ro.mixai.tv.data.DeviceTokenOk
import ro.mixai.tv.data.SessionUser
import ro.mixai.tv.data.TokenResult

private sealed interface SignInState {
    data object Requesting : SignInState
    data class Waiting(val code: DeviceCode, val expiresAt: Long) : SignInState
    data class Connecting(val body: DeviceTokenOk) : SignInState
    data object Expired : SignInState
    data object Denied : SignInState
    data class Failed(val error: Throwable) : SignInState
}

private sealed interface GoogleState {
    data object Idle : GoogleState
    data object Working : GoogleState
    data object NoAccount : GoogleState
    data class Failed(val message: String) : GoogleState
}

/** Opens `url` in a Custom Tab (falls back to any browser). */
fun openInBrowser(context: Context, url: String) {
    runCatching { CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, Uri.parse(url)) }
        .onFailure {
            runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
}

/**
 * MixAI account sign-in. Primary: "Continue with Google" (Credential Manager, native session exchange).
 * Fallback: device-code flow (same contract as the TV): code + QR, "Open browser"
 * (Custom Tab on this phone, approve there), polls `/api/device/token`, then probes the companions.
 */
@Composable
fun SignInScreen(onSignedIn: (body: DeviceTokenOk, picked: Pair<CompanionServer, String>?) -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val web = remember(context) { (context.applicationContext as MixaiPhoneApp).phone.web }
    var google by remember { mutableStateOf<GoogleState>(GoogleState.Idle) }
    val auth = remember { DeviceAuth(BuildConfig.MIXAI_ORIGIN) }
    var state by remember { mutableStateOf<SignInState>(SignInState.Requesting) }
    var secondsLeft by remember { mutableIntStateOf(0) }
    var attempt by remember { mutableIntStateOf(0) }
    val deviceName = remember { "${Build.MODEL} · MixAI" }

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
                if (e.status != 0) { state = SignInState.Failed(e); return@LaunchedEffect }
            } catch (_: Exception) { /* transient */ }
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
    }

    Column(
        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(stringResource(R.string.signin_title), style = MaterialTheme.typography.headlineMedium)
        Button(
            onClick = {
                if (google == GoogleState.Working) return@Button
                google = GoogleState.Working
                scope.launch {
                    google = when (val r = GoogleSignIn.signIn(context, web)) {
                        is GoogleSignInResult.Ok -> {
                            val u = r.session.user
                            onSignedIn(
                                DeviceTokenOk(
                                    session_token = r.session.token,
                                    expires = r.session.expires,
                                    user = SessionUser(id = u.id, name = u.name, image = u.image),
                                    companions = emptyList(),
                                ),
                                null,
                            )
                            GoogleState.Idle
                        }
                        GoogleSignInResult.Cancelled -> GoogleState.Idle
                        GoogleSignInResult.NoAccount -> GoogleState.NoAccount
                        is GoogleSignInResult.Failed -> GoogleState.Failed(r.message)
                    }
                }
            },
            enabled = google != GoogleState.Working,
            modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth(),
        ) { Text(stringResource(R.string.signin_google)) }
        when (val g = google) {
            GoogleState.Working -> Text(stringResource(R.string.signin_google_working), color = MaterialTheme.colorScheme.onSurfaceVariant)
            GoogleState.NoAccount -> Text(stringResource(R.string.signin_google_no_account), color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
            is GoogleState.Failed -> Text(stringResource(R.string.signin_google_failed, g.message), color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
            GoogleState.Idle -> Unit
        }
        Text(stringResource(R.string.signin_or_code), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(stringResource(R.string.signin_open, auth.host), color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        when (val s = state) {
            SignInState.Requesting -> {
                CircularProgressIndicator()
                Text(stringResource(R.string.signin_requesting, auth.host), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            is SignInState.Connecting -> {
                CircularProgressIndicator()
                Text(stringResource(R.string.signin_connecting, s.body.user.name ?: s.body.user.id), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            is SignInState.Waiting -> {
                val url = s.code.verification_uri_complete.ifBlank { s.code.verification_uri }
                Text(stringResource(R.string.signin_your_code), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(s.code.user_code, fontSize = 40.sp, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.secondary, letterSpacing = 4.sp)
                Button(onClick = { openInBrowser(context, url) }, modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
                    Text(stringResource(R.string.signin_open_browser))
                }
                QrCode(url, Modifier.size(200.dp))
                Text(stringResource(R.string.signin_scan_other), color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                Text(
                    if (secondsLeft > 0) stringResource(R.string.signin_expires_in, secondsLeft / 60, secondsLeft % 60) else stringResource(R.string.signin_waiting),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = onBack) { Text(stringResource(R.string.action_back)) }
            }
            SignInState.Expired -> Outcome(stringResource(R.string.signin_expired), stringResource(R.string.signin_new_code), { attempt++ }, onBack)
            SignInState.Denied -> Outcome(stringResource(R.string.signin_denied), stringResource(R.string.action_retry), { attempt++ }, onBack)
            is SignInState.Failed -> Outcome(errorText(s.error), stringResource(R.string.action_retry), { attempt++ }, onBack)
        }
    }
}

@Composable
private fun Outcome(message: String, primary: String, onPrimary: () -> Unit, onBack: () -> Unit) {
    Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
    Button(onClick = onPrimary, modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) { Text(primary) }
    OutlinedButton(onClick = onBack, modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) { Text(stringResource(R.string.action_back)) }
}
