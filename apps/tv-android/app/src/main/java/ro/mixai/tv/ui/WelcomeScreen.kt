package ro.mixai.tv.ui

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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Card
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.ui.theme.Tokens
import ro.mixai.tv.ui.theme.mixaiCardBorder
import ro.mixai.tv.ui.theme.mixaiCardColors
import ro.mixai.tv.ui.theme.mixaiCardScale

/** First-run onboarding: MixAI account (recommended) or a server on this network. */
@Composable
fun WelcomeScreen(onSignIn: () -> Unit, onLocal: () -> Unit) {
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(50); runCatching { first.requestFocus() } }

    Box(Modifier.fillMaxSize().padding(64.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(stringResource(R.string.welcome_title), style = MaterialTheme.typography.headlineLarge, color = Tokens.foreground)
            Text(stringResource(R.string.welcome_subtitle), color = Tokens.mutedForeground)
            Spacer(Modifier.height(24.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                WelcomeCard(
                    icon = "👤",
                    title = stringResource(R.string.welcome_signin_title),
                    desc = stringResource(R.string.welcome_signin_desc),
                    tag = stringResource(R.string.welcome_recommended),
                    modifier = Modifier.focusRequester(first),
                    onClick = onSignIn,
                )
                WelcomeCard(
                    icon = "🖥",
                    title = stringResource(R.string.welcome_local_title),
                    desc = stringResource(R.string.welcome_local_desc),
                    tag = null,
                    onClick = onLocal,
                )
            }
        }
    }
}

@Composable
private fun WelcomeCard(icon: String, title: String, desc: String, tag: String?, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Card(
        onClick = onClick, modifier = modifier.size(width = 480.dp, height = 260.dp),
        colors = mixaiCardColors(), border = mixaiCardBorder(), scale = mixaiCardScale(),
    ) {
        Column(Modifier.fillMaxSize().padding(28.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(icon, fontSize = 36.sp)
            Text(title, style = MaterialTheme.typography.titleLarge, color = Tokens.foreground)
            Text(desc, color = Tokens.mutedForeground, style = MaterialTheme.typography.bodyMedium)
            if (tag != null) {
                Spacer(Modifier.weight(1f))
                Text(tag, color = Tokens.brandCyanDark, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}
