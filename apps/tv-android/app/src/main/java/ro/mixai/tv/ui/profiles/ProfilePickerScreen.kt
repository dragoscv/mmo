package ro.mixai.tv.ui.profiles

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.Icon
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.tv.R
import ro.mixai.tv.data.UnlockResult
import ro.mixai.tv.data.generated.Profile
import ro.mixai.tv.data.isKid
import ro.mixai.tv.ui.components.EmptyState
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.LoadingState
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.NoBackdrop
import ro.mixai.tv.ui.components.PinPad
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

private sealed interface PickerState {
    data object Loading : PickerState
    data class Error(val message: String) : PickerState
    data class Ready(val profiles: List<Profile>) : PickerState
}

/**
 * "Who's watching?" (WP16-18): avatars from `/media/profiles`, PIN pad for locked profiles, kids
 * badge, "Manage profiles" → Settings("profiles"). On success the stack is reset to Home (or the
 * picker is popped when it was opened from the rail and there is something under it).
 */
@Composable
fun ProfilePickerScreen(deps: ScreenDeps, nav: Navigator) {
    NoBackdrop()
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<PickerState>(PickerState.Loading) }
    var reload by remember { mutableIntStateOf(0) }
    var pinFor by remember { mutableStateOf<Profile?>(null) }
    var pinError by remember { mutableIntStateOf(0) }
    var pinMessage by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val active by deps.profiles.activeProfile.collectAsState()
    val firstFocus = remember { FocusRequester() }
    val wrongPinFmt = stringResource(R.string.wp16_pin_wrong_left)
    val wrongPin = stringResource(R.string.wp16_pin_wrong)
    val lockedFmt = stringResource(R.string.wp16_pin_locked)

    LaunchedEffect(reload) {
        state = PickerState.Loading
        state = runCatching { deps.profiles.refresh() }.fold(
            onSuccess = { PickerState.Ready(it) },
            onFailure = { PickerState.Error(it.message ?: it.javaClass.simpleName) },
        )
    }

    fun done() {
        deps.media.invalidateHome()
        deps.hub.refreshHello()
        val under = nav.routes.dropLast(1)
        if (under.isNotEmpty() && under.none { it is Route.Splash }) nav.pop() else nav.resetTo(Route.Home)
    }

    fun choose(p: Profile) {
        if (busy) return
        if (p.hasPin && !(p.id == active?.id && deps.profiles.profileToken.isNotBlank())) {
            pinFor = p; pinMessage = null; return
        }
        busy = true
        scope.launch {
            // Profiles without a PIN still get a token (server accepts any body) so PIN-protected
            // settings of other profiles never leak; failure falls back to plain selection.
            when (deps.profiles.unlock(p, null)) {
                is UnlockResult.Ok -> Unit
                else -> deps.profiles.select(p)
            }
            busy = false
            done()
        }
    }

    // Back inside the PIN pad returns to the grid; on the grid it pops when possible.
    BackHandler(enabled = pinFor != null) { pinFor = null }

    Box(Modifier.fillMaxSize().padding(horizontal = MixaiFocus.overscan, vertical = 48.dp), contentAlignment = Alignment.Center) {
        val pinProfile = pinFor
        when {
            pinProfile != null -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
                ProfileAvatar(pinProfile, size = 96.dp, showKidBadge = pinProfile.isKid)
                Text(stringResource(R.string.wp16_pin_title, pinProfile.name), style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground)
                PinPad(
                    enabled = !busy,
                    errorSignal = pinError,
                    message = pinMessage,
                    onComplete = { pin ->
                        busy = true
                        scope.launch {
                            when (val r = deps.profiles.unlock(pinProfile, pin)) {
                                is UnlockResult.Ok -> { busy = false; pinFor = null; done() }
                                is UnlockResult.WrongPin -> {
                                    pinMessage = r.triesLeft?.let { String.format(wrongPinFmt, it) } ?: wrongPin
                                    pinError++; busy = false
                                }
                                is UnlockResult.Locked -> {
                                    pinMessage = String.format(lockedFmt, ((r.retryAfterMs + 59_999) / 60_000).toInt())
                                    pinError++; busy = false
                                }
                                is UnlockResult.Failed -> { pinMessage = r.message; pinError++; busy = false }
                            }
                        }
                    },
                )
                SecondaryButton(stringResource(R.string.wp16_cancel), onClick = { pinFor = null })
            }
            else -> when (val s = state) {
                PickerState.Loading -> LoadingState(rows = 0, hero = true)
                is PickerState.Error -> ErrorState(s.message, onRetry = { reload++ })
                is PickerState.Ready -> if (s.profiles.isEmpty()) {
                    EmptyState(Icons.Filled.Person, stringResource(R.string.wp16_profiles_empty), stringResource(R.string.wp16_profiles_empty_hint)) { m ->
                        PrimaryButton(stringResource(R.string.wp16_profiles_manage), { nav.push(Route.Settings("profiles")) }, m, icon = Icons.Filled.Settings)
                    }
                } else {
                    LaunchedEffect(s.profiles) { delay(60); runCatching { firstFocus.requestFocus() } }
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(40.dp)) {
                        Text(stringResource(R.string.wp16_profiles_title), style = MaterialTheme.typography.displaySmall, color = Tokens.foreground)
                        val start = s.profiles.indexOfFirst { it.id == active?.id }.coerceAtLeast(0)
                        LazyRow(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(36.dp)) {
                            itemsIndexed(s.profiles, key = { _, p -> p.id }) { i, p ->
                                ProfileTile(p, isActive = p.id == active?.id, modifier = if (i == start) Modifier.focusRequester(firstFocus) else Modifier) { choose(p) }
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            SecondaryButton(stringResource(R.string.wp16_profiles_manage), { nav.push(Route.Settings("profiles")) }, icon = Icons.Filled.Settings)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProfileTile(p: Profile, isActive: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.width(150.dp)) {
        Surface(
            onClick = onClick,
            modifier = modifier.size(132.dp),
            shape = ClickableSurfaceDefaults.shape(CircleShape),
            colors = ClickableSurfaceDefaults.colors(containerColor = Tokens.card, focusedContainerColor = Tokens.card),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1.1f),
            border = ClickableSurfaceDefaults.border(
                focusedBorder = androidx.tv.material3.Border(androidx.compose.foundation.BorderStroke(MixaiFocus.ringWidth, Tokens.ring), shape = CircleShape),
                border = if (isActive) androidx.tv.material3.Border(androidx.compose.foundation.BorderStroke(2.dp, Tokens.mutedForeground), shape = CircleShape) else androidx.tv.material3.Border.None,
            ),
            glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(MixaiFocus.glowColor, MixaiFocus.glowElevation)),
        ) {
            ProfileAvatar(p, size = 132.dp, showKidBadge = p.isKid)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (p.hasPin) Icon(MixaiIcons.Lock, contentDescription = stringResource(R.string.wp16_profile_locked), tint = Tokens.mutedForeground, modifier = Modifier.size(18.dp))
            Text(p.name, style = MaterialTheme.typography.titleMedium, color = Tokens.foreground, textAlign = TextAlign.Center, maxLines = 1)
        }
        if (p.isKid) Text(stringResource(R.string.wp16_profile_kids), style = MaterialTheme.typography.labelSmall, color = Tokens.warning)
        else Spacer(Modifier.height(16.dp))
    }
}
