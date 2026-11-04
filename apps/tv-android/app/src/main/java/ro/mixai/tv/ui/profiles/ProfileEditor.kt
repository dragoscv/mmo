package ro.mixai.tv.ui.profiles

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ro.mixai.tv.R
import ro.mixai.tv.data.UnlockResult
import ro.mixai.tv.data.generated.Profile
import ro.mixai.tv.data.generated.ProfileInput
import ro.mixai.tv.data.isKid
import ro.mixai.tv.ui.components.ConfirmDialog
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PinPad
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.settings.OptionChip
import ro.mixai.tv.ui.settings.PinSetDialog
import ro.mixai.tv.ui.settings.Section
import ro.mixai.tv.ui.settings.SettingRow
import ro.mixai.tv.ui.settings.TextEntryDialog
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

/** Age limits offered for a profile (null = no limit). */
val PROFILE_AGE_LIMITS: List<Long?> = listOf(null, 0L, 7L, 12L, 14L, 15L, 18L)

private sealed interface PinChange {
    data object Keep : PinChange
    data class Set(val pin: String) : PinChange
    data object Remove : PinChange
}

/**
 * Create / edit one viewer profile (WP16-18): name, token colour, adult/kid, age limit, PIN
 * (set/change/remove via PinPad), delete. Editing a PIN profile asks for its PIN first (through
 * [ProfileAdmin], which never switches the active viewer).
 */
@Composable
fun ProfileEditor(
    admin: ProfileAdmin,
    profile: Profile?,
    canDelete: Boolean,
    onDone: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val isNew = profile == null
    var name by remember(profile?.id) { mutableStateOf(profile?.name ?: "") }
    var color by remember(profile?.id) { mutableStateOf(profile?.color ?: PROFILE_COLOR_NAMES.first()) }
    var kid by remember(profile?.id) { mutableStateOf(profile?.isKid == true) }
    var maxAge by remember(profile?.id) { mutableStateOf(profile?.maxAge) }
    var pinChange by remember(profile?.id) { mutableStateOf<PinChange>(PinChange.Keep) }
    var editName by remember { mutableStateOf(isNew) }
    var setPin by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var unlocked by remember(profile?.id) { mutableStateOf(profile == null || admin.canWrite(profile)) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val first = remember { FocusRequester() }

    LaunchedEffect(profile?.id, unlocked) { if (unlocked) { delay(80); runCatching { first.requestFocus() } } }

    if (profile != null && !unlocked) {
        UnlockGate(admin, profile, onUnlocked = { unlocked = true }, onCancel = onCancel, modifier = modifier)
        return
    }

    val hasPin = when (pinChange) { PinChange.Keep -> profile?.hasPin == true; is PinChange.Set -> true; PinChange.Remove -> false }

    fun save() {
        if (name.isBlank() || busy) return
        busy = true; error = null
        scope.launch {
            try {
                if (profile == null) {
                    admin.create(
                        ProfileInput(
                            name = name.trim(), color = color, kind = if (kid) "kid" else "adult",
                            maxAge = maxAge, pin = (pinChange as? PinChange.Set)?.pin,
                        ),
                    )
                } else {
                    val body = buildJsonObject {
                        if (name.trim() != profile.name) put("name", name.trim())
                        if (color != profile.color) put("color", color)
                        val kind = if (kid) "kid" else "adult"
                        if (kind != profile.kind) put("kind", kind)
                        if (maxAge != profile.maxAge || kind != profile.kind) { if (maxAge == null) put("maxAge", JsonNull) else put("maxAge", maxAge) }
                        when (val pc = pinChange) {
                            is PinChange.Set -> put("pin", pc.pin)
                            PinChange.Remove -> put("pin", JsonNull)
                            PinChange.Keep -> Unit
                        }
                    }
                    if (body.isNotEmpty()) admin.update(profile, body)
                }
                onDone()
            } catch (e: Exception) {
                error = e.message ?: e.javaClass.simpleName
            } finally {
                busy = false
            }
        }
    }

    Column(modifier.widthIn(max = 900.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            ProfileAvatar(
                Profile(id = profile?.id ?: "new", name = name.ifBlank { "?" }, color = color, kind = if (kid) "kid" else "adult"),
                size = 88.dp,
                showKidBadge = kid,
            )
            Column {
                Text(
                    stringResource(if (isNew) R.string.profile_new_title else R.string.profile_edit_title),
                    style = MaterialTheme.typography.headlineMedium,
                    color = Tokens.foreground,
                )
                Text(name.ifBlank { stringResource(R.string.profile_name_missing) }, style = MaterialTheme.typography.titleMedium, color = Tokens.mutedForeground)
            }
        }

        Section(stringResource(R.string.profile_name)) {
            SettingRow(stringResource(R.string.profile_name), { editName = true }, Modifier.focusRequester(first), value = name.ifBlank { "—" })
        }

        Section(stringResource(R.string.profile_color)) {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                PROFILE_COLOR_NAMES.forEach { c -> ColorSwatch(c, selected = c == color) { color = c } }
            }
        }

        Section(stringResource(R.string.profile_kind)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OptionChip(stringResource(R.string.profile_kind_adult), !kid, { kid = false })
                OptionChip(stringResource(R.string.profile_kind_kid), kid, { kid = true; if (maxAge == null) maxAge = 7L })
            }
        }

        Section(stringResource(R.string.profile_max_age)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PROFILE_AGE_LIMITS.forEach { a ->
                    val label = if (a == null) stringResource(R.string.profile_max_age_none) else "$a+"
                    OptionChip(label, maxAge == a, { maxAge = a })
                }
            }
            Text(stringResource(R.string.profile_max_age_hint), style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground)
        }

        Section(stringResource(R.string.profile_pin)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                SecondaryButton(stringResource(if (hasPin) R.string.profile_pin_change else R.string.profile_pin_set), { setPin = true }, icon = MixaiIcons.Lock)
                if (hasPin) SecondaryButton(stringResource(R.string.profile_pin_remove), { pinChange = PinChange.Remove })
            }
            Text(
                stringResource(
                    when (pinChange) {
                        PinChange.Keep -> if (hasPin) R.string.profile_pin_on else R.string.profile_pin_off
                        is PinChange.Set -> R.string.profile_pin_pending_set
                        PinChange.Remove -> R.string.profile_pin_pending_remove
                    },
                ),
                style = MaterialTheme.typography.bodySmall,
                color = Tokens.mutedForeground,
            )
        }

        error?.let { Text(stringResource(R.string.profile_save_failed, it), color = Tokens.destructive, style = MaterialTheme.typography.bodyMedium) }

        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            PrimaryButton(stringResource(R.string.profile_save), { save() }, enabled = name.isNotBlank() && !busy)
            SecondaryButton(stringResource(R.string.wp16_cancel), onCancel)
            if (profile != null && canDelete) SecondaryButton(stringResource(R.string.profile_delete), { confirmDelete = true })
        }
    }

    if (editName) {
        TextEntryDialog(
            title = stringResource(R.string.profile_name),
            initial = name,
            onDone = { name = it; editName = false },
            onDismiss = { editName = false },
            maxLength = 24,
        )
    }
    if (setPin) {
        PinSetDialog(
            title = stringResource(R.string.profile_pin_set),
            onDone = { pinChange = PinChange.Set(it); setPin = false },
            onDismiss = { setPin = false },
        )
    }
    if (confirmDelete && profile != null) {
        ConfirmDialog(
            title = stringResource(R.string.profile_delete_confirm_title, profile.name),
            message = stringResource(R.string.profile_delete_confirm_body),
            confirmLabel = stringResource(R.string.profile_delete),
            destructive = true,
            focusDismiss = true,
            onConfirm = {
                confirmDelete = false
                scope.launch {
                    try { admin.delete(profile); onDone() } catch (e: Exception) { error = e.message ?: e.javaClass.simpleName }
                }
            },
            onDismiss = { confirmDelete = false },
        )
    }
}

@Composable
private fun ColorSwatch(name: String, selected: Boolean, onClick: () -> Unit) {
    val c = profileColorOf(name, name)
    Surface(
        onClick = onClick,
        modifier = Modifier.size(52.dp),
        shape = ClickableSurfaceDefaults.shape(CircleShape),
        colors = ClickableSurfaceDefaults.colors(containerColor = c, focusedContainerColor = c),
        border = ClickableSurfaceDefaults.border(
            border = if (selected) Border(BorderStroke(3.dp, Tokens.foreground), shape = CircleShape) else Border.None,
            focusedBorder = Border(BorderStroke(MixaiFocus.ringWidth + 1.dp, Tokens.ring), shape = CircleShape),
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.15f),
        glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(MixaiFocus.glowColor, 10.dp)),
    ) {
        if (selected) Box(Modifier.size(52.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.size(14.dp).background(Tokens.background, CircleShape))
        }
    }
}

/** Asks for the PIN of [profile] before editing it (no active-profile switch). */
@Composable
private fun UnlockGate(admin: ProfileAdmin, profile: Profile, onUnlocked: () -> Unit, onCancel: () -> Unit, modifier: Modifier) {
    val scope = rememberCoroutineScope()
    var errorSignal by remember { mutableIntStateOf(0) }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val wrong = stringResource(R.string.wp16_pin_wrong)
    val wrongLeft = stringResource(R.string.wp16_pin_wrong_left)
    val locked = stringResource(R.string.wp16_pin_locked)
    Column(modifier.fillMaxWidth().padding(top = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
        ProfileAvatar(profile, size = 88.dp, showKidBadge = profile.isKid)
        Text(stringResource(R.string.profile_unlock_to_edit, profile.name), style = MaterialTheme.typography.headlineSmall, color = Tokens.foreground)
        PinPad(
            enabled = !busy,
            errorSignal = errorSignal,
            message = message,
            onComplete = { pin ->
                busy = true
                scope.launch {
                    when (val r = admin.unlock(profile, pin)) {
                        is UnlockResult.Ok -> onUnlocked()
                        is UnlockResult.WrongPin -> { message = r.triesLeft?.let { String.format(wrongLeft, it) } ?: wrong; errorSignal++ }
                        is UnlockResult.Locked -> { message = String.format(locked, ((r.retryAfterMs + 59_999) / 60_000).toInt()); errorSignal++ }
                        is UnlockResult.Failed -> { message = r.message; errorSignal++ }
                    }
                    busy = false
                }
            },
        )
        SecondaryButton(stringResource(R.string.wp16_cancel), onCancel)
    }
}

/** Dialog wrapper used by the profile picker's "Add profile" tile when Settings is not on screen. */
@Composable
fun ProfileEditorDialog(admin: ProfileAdmin, onDone: () -> Unit, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.background(Tokens.popover, RoundedCornerShape(16.dp)).verticalScroll(rememberScrollState()).padding(32.dp)) {
            ProfileEditor(admin, profile = null, canDelete = false, onDone = onDone, onCancel = onDismiss)
        }
    }
}
