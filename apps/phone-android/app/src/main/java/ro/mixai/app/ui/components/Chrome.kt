package ro.mixai.app.ui.components

import ro.mixai.mobile.ui.ProfileAvatar
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator

/** Unwraps ContextWrappers (LocalizedContent wraps the activity context). */
tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/** Active profile avatar → Settings (profile switch, server, account, language). */
@Composable
fun ProfileButton(deps: AppDeps, nav: Navigator, modifier: Modifier = Modifier) {
    val active by deps.profiles.activeProfile.collectAsState()
    val label = stringResource(R.string.profile_menu)
    ProfileAvatar(
        active, size = 34.dp,
        modifier = modifier.clip(CircleShape).clickable { nav.push(Dest.Settings) }.semantics { contentDescription = label },
    )
}

/** Large title + profile button, for tab roots without a hero (Search, Library, Music, Live). */
@Composable
fun TabHeader(title: String, deps: AppDeps, nav: Navigator, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    Row(
        modifier.fillMaxWidth().statusBarsPadding().padding(start = 20.dp, end = 16.dp, top = 12.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.headlineLarge, modifier = Modifier.weight(1f))
        trailing()
        Spacer(Modifier.width(8.dp))
        ProfileButton(deps, nav)
    }
}
