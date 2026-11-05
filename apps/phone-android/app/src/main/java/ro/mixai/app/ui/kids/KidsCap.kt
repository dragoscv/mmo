package ro.mixai.app.ui.kids

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import ro.mixai.app.R
import ro.mixai.app.data.DailyCapError
import ro.mixai.app.data.ProfileUsage

/** What the UI shows about a profile's daily screen time (pure, unit-tested). */
sealed interface CapUi {
    /** Adult, no cap, or not enforced: show nothing. */
    data object Hidden : CapUi
    data class Remaining(val minutes: Long, val capMinutes: Long, val low: Boolean) : CapUi
    data class Locked(val capMinutes: Long?, val watchedMinutes: Long) : CapUi
}

const val CAP_LOW_MINUTES = 10L

fun capUiState(usage: ProfileUsage?, isKid: Boolean): CapUi {
    if (usage == null || !isKid || !usage.enforced) return CapUi.Hidden
    val cap = usage.dailyCapMin ?: return CapUi.Hidden
    if (usage.overCap) return CapUi.Locked(cap, usage.watchMin)
    val left = (usage.remainingMin ?: (cap - usage.watchMin)).coerceAtLeast(0)
    if (left <= 0) return CapUi.Locked(cap, usage.watchMin)
    return CapUi.Remaining(left, cap, left <= CAP_LOW_MINUTES)
}

/** 403 `daily_cap` from a playback route → locked state. */
fun capUiFromError(e: DailyCapError): CapUi.Locked = CapUi.Locked(e.dailyCapMin, e.watchMin)

/** Friendly full-screen "time is up for today" (no error wording). */
@Composable
fun DailyCapLocked(state: CapUi.Locked, profileName: String?, onSwitchProfile: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier) {
    Surface(modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier.fillMaxSize().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        ) {
            Icon(Icons.Outlined.Bedtime, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(72.dp))
            Text(stringResource(R.string.kids_locked_title), style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
            val body = if (state.capMinutes != null) stringResource(R.string.kids_locked_body, profileName ?: "", state.capMinutes)
            else stringResource(R.string.kids_locked_body_nocap, profileName ?: "")
            Text(body, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(stringResource(R.string.kids_locked_tomorrow), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
            Button(onClick = onSwitchProfile, modifier = Modifier.widthIn(max = 360.dp).fillMaxWidth()) { Text(stringResource(R.string.kids_switch_profile)) }
            OutlinedButton(onClick = onBack, modifier = Modifier.widthIn(max = 360.dp).fillMaxWidth()) { Text(stringResource(R.string.action_back)) }
        }
    }
}

/** Small "x min left today" text for kid profiles; null when hidden. */
@Composable
fun capRemainingLabel(state: CapUi): String? = when (state) {
    is CapUi.Remaining -> stringResource(R.string.kids_remaining, state.minutes)
    is CapUi.Locked -> stringResource(R.string.kids_none_left)
    CapUi.Hidden -> null
}
