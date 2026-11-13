package ro.mixai.mobile.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import ro.mixai.mobile.R
import ro.mixai.mobile.theme.BrandMark
import ro.mixai.mobile.theme.BrandProduct
import ro.mixai.mobile.theme.Mixai

/**
 * First run: MixAI account sign-in (recommended) or connect to a server on this network. Title/tagline per app;
 * [product] picks the mark drawn above the name (the name is written under it, so the mark is decorative).
 */
@Composable
fun WelcomeScreen(appName: String, tagline: String, onSignIn: () -> Unit, onLocal: () -> Unit, product: BrandProduct = BrandProduct.Mark) {
    val c = Mixai.colors
    Box(
        Modifier.fillMaxSize().background(
            Brush.verticalGradient(listOf(c.brandViolet.copy(alpha = 0.35f), MaterialTheme.colorScheme.background, MaterialTheme.colorScheme.background)),
        ),
    ) {
        Column(
            Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Bottom,
        ) {
            // Static: the system splash has just played the logo intro. The mark takes only the height that is
            // left over, so on a short (landscape) screen it shrinks instead of pushing the buttons out.
            Box(Modifier.weight(1f, fill = false).padding(bottom = 20.dp), contentAlignment = Alignment.BottomCenter) {
                BrandMark(product = product, modifier = Modifier.sizeIn(maxWidth = 72.dp, maxHeight = 72.dp), decorative = true, light = !c.isDark)
            }
            Text(appName, style = MaterialTheme.typography.displayMedium, color = MaterialTheme.colorScheme.onBackground)
            Spacer(Modifier.height(12.dp))
            Text(
                tagline,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(40.dp))
            Column(Modifier.widthIn(max = 420.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = onSignIn, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text(stringResource(R.string.welcome_sign_in)) }
                OutlinedButton(onClick = onLocal, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text(stringResource(R.string.welcome_local)) }
            }
            Spacer(Modifier.height(16.dp))
            Text(stringResource(R.string.welcome_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            Spacer(Modifier.height(12.dp))
        }
    }
}
