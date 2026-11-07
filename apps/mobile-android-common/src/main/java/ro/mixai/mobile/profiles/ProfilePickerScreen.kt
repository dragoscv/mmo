package ro.mixai.mobile.profiles

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.mobile.R
import ro.mixai.mobile.ui.EmptyState
import ro.mixai.mobile.ui.ErrorState
import ro.mixai.mobile.ui.ProfileAvatar
import ro.mixai.mobile.ui.SkeletonBox
import ro.mixai.tv.data.ProfileRepository
import ro.mixai.tv.data.UnlockResult
import ro.mixai.tv.data.generated.Profile
import ro.mixai.tv.data.isKid
import kotlin.math.roundToInt

private sealed interface PickerState {
    data object Loading : PickerState
    data class Error(val e: Throwable) : PickerState
    data class Ready(val profiles: List<Profile>) : PickerState
}

/** "Who's watching?" grid + numeric PIN pad for locked profiles (tries left / lock countdown). */
@Composable
fun ProfilePickerScreen(profiles: ProfileRepository, onSelected: () -> Unit = {}, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<PickerState>(PickerState.Loading) }
    var reload by remember { mutableIntStateOf(0) }
    var pinFor by remember { mutableStateOf<Profile?>(null) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(reload) {
        state = runCatching { profiles.refresh() }.fold({ PickerState.Ready(it) }, { PickerState.Error(it) })
    }

    fun finish() { onSelected(); onDone() }

    fun choose(p: Profile) {
        if (busy) return
        if (p.hasPin && !(p.id == profiles.activeProfile.value?.id && profiles.profileToken.isNotBlank())) { pinFor = p; return }
        busy = true
        scope.launch {
            if (profiles.unlock(p, null) !is UnlockResult.Ok) profiles.select(p)
            busy = false
            finish()
        }
    }

    BackHandler(enabled = pinFor != null) { pinFor = null }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).statusBarsPadding().navigationBarsPadding()) {
        val pin = pinFor
        if (pin != null) {
            PinEntry(profiles, pin, onCancel = { pinFor = null }, onUnlocked = { pinFor = null; finish() })
            return@Box
        }
        Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.height(32.dp))
            Text(stringResource(R.string.profiles_title), style = MaterialTheme.typography.headlineLarge)
            Spacer(Modifier.height(28.dp))
            when (val s = state) {
                PickerState.Loading -> Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    repeat(3) { SkeletonBox(Modifier.size(88.dp).clip(CircleShape)) }
                }
                is PickerState.Error -> ErrorState(s.e, onRetry = { reload++ })
                is PickerState.Ready -> if (s.profiles.isEmpty()) {
                    EmptyState(Icons.Filled.Person, stringResource(R.string.profiles_empty), stringResource(R.string.profiles_empty_hint))
                } else {
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(112.dp),
                        modifier = Modifier.widthIn(max = 560.dp),
                        horizontalArrangement = Arrangement.spacedBy(16.dp),
                        verticalArrangement = Arrangement.spacedBy(24.dp),
                    ) {
                        items(s.profiles, key = { it.id }) { p ->
                            Column(
                                Modifier.clip(MaterialTheme.shapes.medium).clickable(enabled = !busy) { choose(p) }.padding(8.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Box {
                                    ProfileAvatar(p, size = 88.dp, showKidBadge = p.isKid)
                                    if (p.hasPin) Icon(
                                        Icons.Filled.Lock, stringResource(R.string.profiles_locked),
                                        Modifier.align(Alignment.TopEnd).size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                Spacer(Modifier.height(8.dp))
                                Text(p.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PinEntry(profiles: ProfileRepository, profile: Profile, onCancel: () -> Unit, onUnlocked: () -> Unit) {
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    var pad by remember { mutableStateOf(PinPadState()) }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var lockedUntil by remember { mutableLongStateOf(0L) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val shake = remember { Animatable(0f) }
    val wrongFmt = stringResource(R.string.pin_wrong_left)
    val wrong = stringResource(R.string.pin_wrong)

    LaunchedEffect(lockedUntil) {
        while (lockedUntil > System.currentTimeMillis()) { now = System.currentTimeMillis(); delay(1000) }
        now = System.currentTimeMillis()
    }
    suspend fun fail(msg: String?) {
        message = msg; pad = pad.clear(); busy = false
        haptics.performHapticFeedback(HapticFeedbackType.Reject)
        for (x in listOf(18f, -14f, 10f, -6f, 0f)) shake.animateTo(x)
    }
    LaunchedEffect(pad.isComplete) {
        if (!pad.isComplete || busy) return@LaunchedEffect
        busy = true
        when (val r = profiles.unlock(profile, pad.digits)) {
            is UnlockResult.Ok -> { busy = false; onUnlocked() }
            is UnlockResult.WrongPin -> fail(r.triesLeft?.let { String.format(wrongFmt, it) } ?: wrong)
            is UnlockResult.Locked -> { lockedUntil = System.currentTimeMillis() + r.retryAfterMs; fail(null) }
            is UnlockResult.Failed -> fail(r.message)
        }
    }
    val locked = lockedUntil > now
    val secs = ((lockedUntil - now + 999) / 1000).coerceAtLeast(0)

    Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        ProfileAvatar(profile, size = 80.dp, showKidBadge = profile.isKid)
        Spacer(Modifier.height(12.dp))
        Text(stringResource(R.string.pin_title, profile.name), style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        Spacer(Modifier.height(20.dp))
        Row(Modifier.offset { IntOffset(shake.value.roundToInt(), 0) }, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            repeat(pad.length) { i ->
                Box(
                    Modifier.size(16.dp).clip(CircleShape).background(
                        if (i < pad.digits.length) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHighest,
                    ),
                )
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(
            if (locked) stringResource(R.string.pin_locked, secs / 60, secs % 60) else message ?: " ",
            color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(16.dp))
        val enabled = !busy && !locked
        Column(Modifier.width(280.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf(listOf(1, 2, 3), listOf(4, 5, 6), listOf(7, 8, 9)).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    row.forEach { d -> PinKey(d.toString(), enabled, Modifier.weight(1f)) { pad = pad.press(d); message = null } }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Spacer(Modifier.weight(1f))
                PinKey("0", enabled, Modifier.weight(1f)) { pad = pad.press(0); message = null }
                Box(Modifier.weight(1f).aspectRatio(1.4f), contentAlignment = Alignment.Center) {
                    IconButton(onClick = { pad = pad.backspace() }, enabled = enabled && pad.digits.isNotEmpty()) {
                        Icon(Icons.AutoMirrored.Filled.Backspace, stringResource(R.string.pin_delete))
                    }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        TextButton(onClick = onCancel) { Text(stringResource(R.string.common_action_cancel)) }
    }
}

@Composable
private fun PinKey(label: String, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier.aspectRatio(1.4f).clip(MaterialTheme.shapes.large)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = MaterialTheme.typography.headlineSmall) }
}
