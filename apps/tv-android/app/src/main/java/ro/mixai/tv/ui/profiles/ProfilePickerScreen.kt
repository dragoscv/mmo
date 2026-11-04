package ro.mixai.tv.ui.profiles

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Border
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

/** Tiles per row: 1..6 in one row, 7..12 split into two balanced rows. */
internal fun pickerRows(n: Int): Int = if (n <= 6) 1 else (n + 5) / 6

/**
 * "Who's watching?" (WP16-18): avatars from `/media/profiles` in a centered grid (1..12+), PIN pad
 * for locked profiles (shake + tries left, locked countdown), kids badge, "Add profile" tile →
 * editor, "Manage profiles" → Settings("profiles"). Focus returns to the last chosen tile.
 */
@Composable
fun ProfilePickerScreen(deps: ScreenDeps, nav: Navigator) {
    NoBackdrop()
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<PickerState>(PickerState.Loading) }
    var reload by remember { mutableIntStateOf(0) }
    var pinForId by rememberSaveable { mutableStateOf<String?>(null) }
    var pinError by remember { mutableIntStateOf(0) }
    var pinMessage by remember { mutableStateOf<String?>(null) }
    var lockedUntil by remember { mutableLongStateOf(0L) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var busy by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var lastFocused by rememberSaveable { mutableStateOf<String?>(null) }
    val active by deps.profiles.activeProfile.collectAsState()
    val admin = remember(deps) { ProfileAdmin(deps.api, deps.profiles) }
    val wrongPinFmt = stringResource(R.string.wp16_pin_wrong_left)
    val wrongPin = stringResource(R.string.wp16_pin_wrong)

    LaunchedEffect(reload) {
        if (state !is PickerState.Ready) state = PickerState.Loading
        state = runCatching { deps.profiles.refresh() }.fold(
            onSuccess = { PickerState.Ready(it) },
            onFailure = { PickerState.Error(it.message ?: it.javaClass.simpleName) },
        )
    }
    LaunchedEffect(lockedUntil) {
        while (lockedUntil > System.currentTimeMillis()) { now = System.currentTimeMillis(); delay(1000) }
        now = System.currentTimeMillis()
        if (lockedUntil != 0L) { lockedUntil = 0L; pinMessage = null }
    }

    val profiles = (state as? PickerState.Ready)?.profiles.orEmpty()
    val pinProfile = profiles.firstOrNull { it.id == pinForId }

    fun done() {
        deps.media.invalidateHome()
        deps.hub.refreshHello()
        val under = nav.routes.dropLast(1)
        if (under.isNotEmpty() && under.none { it is Route.Splash || it is Route.ProfilePicker }) nav.pop() else nav.resetTo(Route.Home)
    }

    fun choose(p: Profile) {
        if (busy) return
        lastFocused = p.id
        if (p.hasPin && !(p.id == active?.id && deps.profiles.profileToken.isNotBlank())) {
            pinForId = p.id; pinMessage = null; return
        }
        busy = true
        scope.launch {
            // Profiles without a PIN still get a token so PIN-protected settings of other profiles
            // never leak; failure falls back to plain selection.
            if (deps.profiles.unlock(p, null) !is UnlockResult.Ok) deps.profiles.select(p)
            busy = false
            done()
        }
    }

    BackHandler(enabled = pinForId != null) { pinForId = null; pinMessage = null }

    Box(Modifier.fillMaxSize().padding(horizontal = MixaiFocus.overscan, vertical = 48.dp), contentAlignment = Alignment.Center) {
        when {
            pinProfile != null -> {
                val isLocked = lockedUntil > now
                val secsLeft = ((lockedUntil - now + 999) / 1000).coerceAtLeast(0)
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
                    ProfileAvatar(pinProfile, size = 104.dp, showKidBadge = pinProfile.isKid)
                    Text(stringResource(R.string.wp16_pin_title, pinProfile.name), style = MaterialTheme.typography.headlineMedium, color = Tokens.foreground)
                    PinPad(
                        enabled = !busy && !isLocked,
                        errorSignal = pinError,
                        message = if (isLocked) stringResource(R.string.profile_pin_locked_countdown, secsLeft / 60, secsLeft % 60) else pinMessage,
                        onComplete = { pin ->
                            busy = true
                            scope.launch {
                                when (val r = deps.profiles.unlock(pinProfile, pin)) {
                                    is UnlockResult.Ok -> { busy = false; pinForId = null; done() }
                                    is UnlockResult.WrongPin -> {
                                        pinMessage = r.triesLeft?.let { String.format(wrongPinFmt, it) } ?: wrongPin
                                        pinError++; busy = false
                                    }
                                    is UnlockResult.Locked -> {
                                        lockedUntil = System.currentTimeMillis() + r.retryAfterMs
                                        pinError++; busy = false
                                    }
                                    is UnlockResult.Failed -> { pinMessage = r.message; pinError++; busy = false }
                                }
                            }
                        },
                    )
                    SecondaryButton(stringResource(R.string.wp16_cancel), onClick = { pinForId = null; pinMessage = null })
                }
            }
            else -> when (val s = state) {
                PickerState.Loading -> LoadingState(rows = 0, hero = true)
                is PickerState.Error -> ErrorState(s.message, onRetry = { reload++ })
                is PickerState.Ready -> if (s.profiles.isEmpty()) {
                    EmptyState(Icons.Filled.Person, stringResource(R.string.wp16_profiles_empty), stringResource(R.string.wp16_profiles_empty_hint)) { m ->
                        PrimaryButton(stringResource(R.string.profile_add), { adding = true }, m, icon = Icons.Filled.Add)
                    }
                } else {
                    ProfileGrid(
                        profiles = s.profiles,
                        activeId = active?.id,
                        focusId = lastFocused ?: active?.id ?: s.profiles.first().id,
                        onChoose = ::choose,
                        onAdd = { adding = true },
                        onManage = { nav.push(Route.Settings("profiles")) },
                    )
                }
            }
        }
    }

    if (adding) {
        ProfileEditorDialog(
            admin = admin,
            onDone = { adding = false; reload++ },
            onDismiss = { adding = false },
        )
    }
}

@Composable
private fun ProfileGrid(
    profiles: List<Profile>,
    activeId: String?,
    focusId: String,
    onChoose: (Profile) -> Unit,
    onAdd: () -> Unit,
    onManage: () -> Unit,
) {
    val firstFocus = remember { FocusRequester() }
    val tiles: List<Profile?> = profiles + null // null = "Add profile"
    val rows = pickerRows(tiles.size)
    val perRow = (tiles.size + rows - 1) / rows
    val tileSize = if (tiles.size > 6) 112.dp else 132.dp
    LaunchedEffect(profiles) { delay(60); runCatching { firstFocus.requestFocus() } }
    Column(
        Modifier.verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(36.dp),
    ) {
        Text(stringResource(R.string.wp16_profiles_title), style = MaterialTheme.typography.displaySmall, color = Tokens.foreground)
        Column(Modifier.focusRestorer(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(28.dp)) {
            tiles.chunked(perRow).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                    row.forEach { p ->
                        val m = if (p?.id == focusId || (p == null && profiles.none { it.id == focusId })) Modifier.focusRequester(firstFocus) else Modifier
                        if (p != null) ProfileTile(p, isActive = p.id == activeId, size = tileSize, modifier = m) { onChoose(p) }
                        else AddTile(size = tileSize, modifier = m, onClick = onAdd)
                    }
                }
            }
        }
        SecondaryButton(stringResource(R.string.wp16_profiles_manage), onManage, icon = Icons.Filled.Settings)
    }
}

@Composable
private fun ProfileTile(p: Profile, isActive: Boolean, size: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val avatarScale by animateFloatAsState(if (focused) 1.06f else 1f, spring(dampingRatio = 0.6f, stiffness = 400f), label = "avatar")
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.width(size + 24.dp)) {
        Surface(
            onClick = onClick,
            modifier = modifier.size(size).onFocusChanged { focused = it.isFocused },
            shape = ClickableSurfaceDefaults.shape(CircleShape),
            colors = ClickableSurfaceDefaults.colors(containerColor = Tokens.card, focusedContainerColor = Tokens.card),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1.1f),
            border = ClickableSurfaceDefaults.border(
                focusedBorder = Border(BorderStroke(MixaiFocus.ringWidth, Tokens.ring), shape = CircleShape),
                border = if (isActive) Border(BorderStroke(2.dp, Tokens.mutedForeground), shape = CircleShape) else Border.None,
            ),
            glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(MixaiFocus.glowColor, MixaiFocus.glowElevation)),
        ) {
            ProfileAvatar(p, size = size, showKidBadge = p.isKid, modifier = Modifier.graphicsLayer { scaleX = avatarScale; scaleY = avatarScale })
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (p.hasPin) Icon(MixaiIcons.Lock, contentDescription = stringResource(R.string.wp16_profile_locked), tint = Tokens.mutedForeground, modifier = Modifier.size(18.dp))
            Text(
                p.name,
                style = MaterialTheme.typography.titleMedium,
                color = if (focused) Tokens.foreground else Tokens.mutedForeground,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (p.isKid) Text(stringResource(R.string.wp16_profile_kids), style = MaterialTheme.typography.labelSmall, color = Tokens.warning)
        else Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun AddTile(size: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.width(size + 24.dp)) {
        Surface(
            onClick = onClick,
            modifier = modifier.size(size).onFocusChanged { focused = it.isFocused },
            shape = ClickableSurfaceDefaults.shape(CircleShape),
            colors = ClickableSurfaceDefaults.colors(
                containerColor = Tokens.foreground.copy(alpha = 0.06f),
                contentColor = Tokens.mutedForeground,
                focusedContainerColor = Tokens.foreground,
                focusedContentColor = Tokens.background,
            ),
            border = ClickableSurfaceDefaults.border(
                border = Border(BorderStroke(2.dp, Tokens.mutedForeground.copy(alpha = 0.5f)), shape = CircleShape),
                focusedBorder = Border(BorderStroke(MixaiFocus.ringWidth, Tokens.ring), shape = CircleShape),
            ),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1.1f),
        ) {
            Box(Modifier.size(size), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(size * 0.4f))
            }
        }
        Text(
            stringResource(R.string.profile_add),
            style = MaterialTheme.typography.titleMedium,
            color = if (focused) Tokens.foreground else Tokens.mutedForeground,
            maxLines = 1,
        )
        Spacer(Modifier.height(16.dp))
    }
}
