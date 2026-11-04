package ro.mixai.tv.ui.settings

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Person
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import coil3.SingletonImageLoader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ro.mixai.tv.BuildConfig
import ro.mixai.tv.R
import ro.mixai.tv.data.Health
import ro.mixai.tv.data.HubStatus
import ro.mixai.tv.data.generated.MediaStatus
import ro.mixai.tv.data.generated.Profile
import ro.mixai.tv.data.generated.ProfileInput
import ro.mixai.tv.data.isKid
import ro.mixai.tv.ui.ScreenFormat
import ro.mixai.tv.ui.components.Choice
import ro.mixai.tv.ui.components.ChoiceDialog
import ro.mixai.tv.ui.components.ConfirmDialog
import ro.mixai.tv.ui.components.IconActionButton
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.detectPanelAspect
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.RAIL_ITEMS
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.profiles.ProfileAdmin
import ro.mixai.tv.ui.profiles.ProfileAvatar
import ro.mixai.tv.ui.profiles.ProfileEditor
import ro.mixai.tv.ui.profiles.ProfilePrefKeys
import ro.mixai.tv.ui.profiles.prefBool
import ro.mixai.tv.ui.profiles.prefString
import ro.mixai.tv.ui.profiles.prefValue
import ro.mixai.tv.data.Settings as AppSettings
import ro.mixai.tv.ui.theme.Tokens
import java.io.File
import java.util.Locale

// Detail panes of SettingsScreen (WP16-27). Each pane is a plain Column fragment.

// ─── Profiles ─────────────────────────────────────────────────────────────────

private sealed interface Editing {
    data object None : Editing
    data object New : Editing
    data class Existing(val id: String) : Editing
}

@Composable
internal fun ProfilesPane(deps: ScreenDeps, nav: Navigator) {
    val list by deps.profiles.profiles.collectAsState()
    val active by deps.profiles.activeProfile.collectAsState()
    var editing by remember { mutableStateOf<Editing>(Editing.None) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val admin = remember(deps) { ProfileAdmin(deps.api, deps.profiles) }

    LaunchedEffect(reload) { error = runCatching { deps.profiles.refresh() }.exceptionOrNull()?.let { it.message ?: it.javaClass.simpleName } }

    when (val e = editing) {
        Editing.New -> ProfileEditor(admin, null, canDelete = false, onDone = { editing = Editing.None; reload++ }, onCancel = { editing = Editing.None })
        is Editing.Existing -> {
            val p = list.firstOrNull { it.id == e.id }
            if (p == null) LaunchedEffect(e.id) { editing = Editing.None }
            else ProfileEditor(admin, p, canDelete = list.size > 1, onDone = { editing = Editing.None; reload++ }, onCancel = { editing = Editing.None })
        }
        Editing.None -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.set_profiles_hint), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
            list.forEach { p ->
                SettingRow(
                    title = p.name,
                    subtitle = profileSummary(p, p.id == active?.id),
                    leading = { ProfileAvatar(p, size = 40.dp, showKidBadge = p.isKid) },
                    value = if (p.hasPin) stringResource(R.string.wp16_profile_locked) else null,
                    onClick = { editing = Editing.Existing(p.id) },
                )
            }
            SettingRow(stringResource(R.string.profile_add), { editing = Editing.New }, icon = Icons.Filled.Add)
            SettingRow(stringResource(R.string.wp16_profile_switch), { nav.push(Route.ProfilePicker) }, icon = Icons.Filled.Person)
            error?.let { Text(it, color = Tokens.destructive, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
private fun profileSummary(p: Profile, isActive: Boolean): String {
    val parts = mutableListOf<String>()
    if (isActive) parts += stringResource(R.string.set_profile_active)
    parts += stringResource(if (p.isKid) R.string.profile_kind_kid else R.string.profile_kind_adult)
    p.maxAge?.let { parts += stringResource(R.string.set_profile_max_age_value, it.toInt()) }
    return parts.joinToString(" · ")
}

// ─── Playback + subtitles (stored in the ACTIVE profile's prefs) ───────────────

/** Writes one key into the active profile's prefs (server merges keys). */
@Composable
private fun rememberPrefWriter(deps: ScreenDeps, onError: (String) -> Unit): (String, Any) -> Unit {
    val scope = rememberCoroutineScope()
    return remember(deps) {
        { key, value ->
            val p = deps.profiles.activeProfile.value
            if (p != null) scope.launch {
                runCatching { deps.profiles.update(p.id, ProfileInput(prefs = mapOf(key to prefValue(value)))) }
                    .onFailure { onError(it.message ?: it.javaClass.simpleName) }
            }
        }
    }
}

private val LANG_CODES = listOf("ro", "en", "fr", "de", "es", "it", "hu", "pt", "nl", "pl", "tr", "ja", "ko")

private fun langName(code: String, uiLang: String): String {
    val n = Locale.forLanguageTag(code).getDisplayLanguage(Locale.forLanguageTag(uiLang.ifBlank { Locale.getDefault().language }))
    return n.replaceFirstChar { it.titlecase(Locale.ROOT) }
}

@Composable
internal fun PlaybackPane(deps: ScreenDeps) {
    val active by deps.profiles.activeProfile.collectAsState()
    var error by remember { mutableStateOf<String?>(null) }
    val write = rememberPrefWriter(deps) { error = it }
    var pick by remember { mutableStateOf<String?>(null) } // "audio" | "sub" | "format"
    val scope = rememberCoroutineScope()
    val formatKey by deps.settings.screenFormat.collectAsState(initial = "auto")
    val p = active
    val auto = stringResource(R.string.set_lang_auto)
    val off = stringResource(R.string.set_sub_off)

    if (p == null) {
        Text(stringResource(R.string.wp16_profile_none), color = Tokens.mutedForeground)
    } else {
        val audio = p.prefString(ProfilePrefKeys.AUDIO_LANG, "")
        val sub = p.prefString(ProfilePrefKeys.SUB_LANG, "")
        Text(stringResource(R.string.set_playback_for, p.name), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
        Section(stringResource(R.string.set_sec_playback)) {
            ToggleRow(stringResource(R.string.set_autoplay_next), p.prefBool(ProfilePrefKeys.AUTOPLAY_NEXT, true), { write(ProfilePrefKeys.AUTOPLAY_NEXT, it) })
            ToggleRow(stringResource(R.string.set_skip_intro), p.prefBool(ProfilePrefKeys.SKIP_INTRO, false), { write(ProfilePrefKeys.SKIP_INTRO, it) }, subtitle = stringResource(R.string.set_skip_intro_hint))
        }
        Section(stringResource(R.string.set_languages)) {
            SettingRow(stringResource(R.string.set_audio_lang), { pick = "audio" }, value = if (audio.isBlank()) auto else langName(audio, deps.lang), icon = MixaiIcons.Audiotrack)
            SettingRow(
                stringResource(R.string.set_sub_lang),
                { pick = "sub" },
                value = when (sub) { "" -> auto; "off" -> off; else -> langName(sub, deps.lang) },
                icon = MixaiIcons.Subtitles,
            )
            ToggleRow(stringResource(R.string.set_sub_forced_only), p.prefBool(ProfilePrefKeys.SUB_FORCED_ONLY, false), { write(ProfilePrefKeys.SUB_FORCED_ONLY, it) }, subtitle = stringResource(R.string.set_sub_forced_hint))
        }
        error?.let { Text(stringResource(R.string.profile_save_failed, it), color = Tokens.destructive, style = MaterialTheme.typography.bodySmall) }

        when (pick) {
            "audio" -> ChoicePopup(
                stringResource(R.string.set_audio_lang),
                listOf(Choice("", auto, stringResource(R.string.set_lang_auto_hint))) + LANG_CODES.map { Choice(it, langName(it, deps.lang)) },
                audio,
                onPick = { write(ProfilePrefKeys.AUDIO_LANG, it); pick = null },
                onDismiss = { pick = null },
            )
            "sub" -> ChoicePopup(
                stringResource(R.string.set_sub_lang),
                listOf(Choice("", auto, stringResource(R.string.set_lang_auto_hint)), Choice("off", off)) + LANG_CODES.map { Choice(it, langName(it, deps.lang)) },
                sub,
                onPick = { write(ProfilePrefKeys.SUB_LANG, it); pick = null },
                onDismiss = { pick = null },
            )
        }
    }

    // Device-wide (not per profile): panel shape correction for ultrawide monitors.
    Section(stringResource(R.string.settings_screen_format)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val set: (String) -> Unit = { k -> scope.launch { deps.settings.setScreenFormat(k) } }
            OptionChip(stringResource(R.string.settings_screen_auto), formatKey == ScreenFormat.Auto.key, { set(ScreenFormat.Auto.key) })
            OptionChip("16:9", formatKey == ScreenFormat.Wide16x9.key, { set(ScreenFormat.Wide16x9.key) })
            OptionChip("21:9", formatKey == ScreenFormat.Ultra21x9.key, { set(ScreenFormat.Ultra21x9.key) })
            OptionChip("32:9", formatKey == ScreenFormat.Super32x9.key, { set(ScreenFormat.Super32x9.key) })
        }
        Text(stringResource(R.string.settings_screen_hint), color = Tokens.mutedForeground, style = MaterialTheme.typography.bodySmall)
    }
}

/** [ChoiceDialog] hosted in its own window so it covers the screen from inside a scrolled pane. */
@Composable
internal fun <T> ChoicePopup(title: String, options: List<Choice<T>>, selected: T?, onPick: (T) -> Unit, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize()) { ChoiceDialog(title, options, selected, onPick, onDismiss) }
    }
}

/** Subtitle sizes (`subSize`) and backgrounds (`subBg`); the player maps them to its renderer. */
val SUB_SIZES = listOf("small", "medium", "large", "xlarge")
val SUB_BGS = listOf("none", "shadow", "box")

@Composable
internal fun SubtitlesPane(deps: ScreenDeps) {
    val active by deps.profiles.activeProfile.collectAsState()
    var error by remember { mutableStateOf<String?>(null) }
    val write = rememberPrefWriter(deps) { error = it }
    val p = active ?: run { Text(stringResource(R.string.wp16_profile_none), color = Tokens.mutedForeground); return }
    val size = p.prefString(ProfilePrefKeys.SUB_SIZE, "medium")
    val bg = p.prefString(ProfilePrefKeys.SUB_BG, "shadow")

    Section(stringResource(R.string.set_sub_size)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SUB_SIZES.forEach { s -> OptionChip(stringResource(subSizeLabel(s)), size == s, { write(ProfilePrefKeys.SUB_SIZE, s) }) }
        }
    }
    Section(stringResource(R.string.set_sub_bg)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SUB_BGS.forEach { b -> OptionChip(stringResource(subBgLabel(b)), bg == b, { write(ProfilePrefKeys.SUB_BG, b) }) }
        }
    }
    Section(stringResource(R.string.set_sub_preview)) {
        Box(
            Modifier.fillMaxWidth().padding(vertical = 4.dp).background(Tokens.card, RoundedCornerShape(12.dp)).padding(vertical = 36.dp),
            contentAlignment = Alignment.Center,
        ) {
            val fontSize = when (size) { "small" -> 18.sp; "large" -> 30.sp; "xlarge" -> 36.sp; else -> 24.sp }
            val shadow = if (bg == "shadow") androidx.compose.ui.graphics.Shadow(Tokens.background, blurRadius = 6f) else null
            Text(
                stringResource(R.string.set_sub_sample),
                style = TextStyle(fontSize = fontSize, fontWeight = FontWeight.Medium, color = Tokens.foreground, shadow = shadow),
                modifier = if (bg == "box") Modifier.background(Tokens.background.copy(alpha = 0.75f), RoundedCornerShape(4.dp)).padding(horizontal = 10.dp, vertical = 4.dp) else Modifier,
            )
        }
    }
    error?.let { Text(stringResource(R.string.profile_save_failed, it), color = Tokens.destructive, style = MaterialTheme.typography.bodySmall) }
}

private fun subSizeLabel(s: String) = when (s) {
    "small" -> R.string.set_sub_size_small
    "large" -> R.string.set_sub_size_large
    "xlarge" -> R.string.set_sub_size_xlarge
    else -> R.string.set_sub_size_medium
}

private fun subBgLabel(b: String) = when (b) {
    "none" -> R.string.set_sub_bg_none
    "box" -> R.string.set_sub_bg_box
    else -> R.string.set_sub_bg_shadow
}

// ─── Language ──────────────────────────────────────────────────────────────────

@Composable
internal fun LanguagePane(deps: ScreenDeps) {
    val scope = rememberCoroutineScope()
    val set: (String) -> Unit = { tag -> scope.launch { deps.settings.setLocale(tag) } }
    Text(stringResource(R.string.set_language_hint), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        OptionChip(stringResource(R.string.settings_lang_system), deps.localeTag == "", { set("") })
        OptionChip(stringResource(R.string.settings_lang_ro), deps.localeTag == "ro", { set("ro") })
        OptionChip(stringResource(R.string.settings_lang_en), deps.localeTag == "en", { set("en") })
    }
}

// ─── Navigation (rail order / visibility) ──────────────────────────────────────

/** Reorders/hides rail items: [order] = visible ids in order; hidden = the rest. Settings stays visible. */
internal fun moveNavItem(order: List<String>, id: String, delta: Int): List<String> {
    val i = order.indexOf(id)
    val j = i + delta
    if (i < 0 || j !in order.indices) return order
    return order.toMutableList().apply { add(j, removeAt(i)) }
}

internal fun toggleNavItem(order: List<String>, id: String): List<String> =
    if (id in order) { if (id == "settings") order else order - id } else order + id

@Composable
internal fun NavigationPane(deps: ScreenDeps) {
    val scope = rememberCoroutineScope()
    val order by deps.settings.navOrder.collectAsState(initial = AppSettings.DEFAULT_NAV_ORDER)
    val all = RAIL_ITEMS.keys.toList()
    val visible = order.filter { it in RAIL_ITEMS }
    val hidden = all.filterNot { it in visible }
    fun save(list: List<String>) { scope.launch { deps.settings.setNavOrder(list) } }

    Text(stringResource(R.string.set_nav_hint), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        (visible + hidden).forEach { id ->
            val item = RAIL_ITEMS.getValue(id)
            val shown = id in visible
            val idx = visible.indexOf(id)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SettingRow(
                    title = stringResource(item.labelRes),
                    icon = item.icon,
                    value = stringResource(if (shown) R.string.set_nav_visible else R.string.set_nav_hidden),
                    enabled = id != "settings",
                    onClick = { save(toggleNavItem(visible, id)) },
                    modifier = Modifier.weight(1f),
                )
                IconActionButton(Icons.Filled.KeyboardArrowUp, stringResource(R.string.set_nav_up), { save(moveNavItem(visible, id, -1)) }, enabled = shown && idx > 0)
                IconActionButton(Icons.Filled.KeyboardArrowDown, stringResource(R.string.set_nav_down), { save(moveNavItem(visible, id, 1)) }, enabled = shown && idx < visible.lastIndex)
            }
        }
    }
    SecondaryButton(stringResource(R.string.set_nav_reset), { save(AppSettings.DEFAULT_NAV_ORDER) })
}

// ─── Server ────────────────────────────────────────────────────────────────────

private sealed interface Probe<out T> {
    data object Loading : Probe<Nothing>
    data class Ok<T>(val value: T) : Probe<T>
    data class Failed(val message: String) : Probe<Nothing>
}

@Composable
internal fun ServerPane(deps: ScreenDeps, nav: Navigator) {
    var health by remember { mutableStateOf<Probe<Health>>(Probe.Loading) }
    var confirm by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(reload) {
        health = Probe.Loading
        health = runCatching { deps.api.health() }.fold({ Probe.Ok(it) }, { Probe.Failed(it.message ?: it.javaClass.simpleName) })
    }
    InfoRow(stringResource(R.string.set_server_url), deps.api.baseUrl)
    InfoRow(
        stringResource(R.string.set_server_status),
        when (val h = health) {
            Probe.Loading -> stringResource(R.string.settings_server_checking)
            is Probe.Ok -> stringResource(R.string.settings_server_info, h.value.hostname, h.value.version)
            is Probe.Failed -> stringResource(R.string.settings_server_unreachable)
        },
        valueColor = if (health is Probe.Failed) Tokens.destructive else Tokens.foreground,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        SecondaryButton(stringResource(R.string.set_server_recheck), { reload++ })
        SecondaryButton(stringResource(R.string.home_change_server), { confirm = true })
    }
    Section(stringResource(R.string.wp16_nav_livetv)) {
        SettingRow(stringResource(R.string.set_livetv_sources), { nav.push(Route.LiveTv) }, icon = MixaiIcons.LiveTv, subtitle = stringResource(R.string.set_livetv_sources_hint))
    }
    if (confirm) {
        ConfirmDialog(
            title = stringResource(R.string.set_change_server_title),
            message = stringResource(R.string.set_change_server_body),
            confirmLabel = stringResource(R.string.home_change_server),
            focusDismiss = true,
            onConfirm = { confirm = false; deps.onChangeServer() },
            onDismiss = { confirm = false },
        )
    }
}

// ─── Account ───────────────────────────────────────────────────────────────────

@Composable
internal fun AccountPane(deps: ScreenDeps) {
    val signOut = deps.onSignOut
    var confirm by remember { mutableStateOf(false) }
    if (deps.session.isSignedIn && signOut != null) {
        InfoRow(stringResource(R.string.set_account_signed_in), deps.session.displayName)
        SecondaryButton(stringResource(R.string.home_sign_out), { confirm = true })
    } else {
        Text(stringResource(R.string.set_account_none), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
    }
    if (confirm && signOut != null) {
        ConfirmDialog(
            title = stringResource(R.string.set_sign_out_title),
            message = stringResource(R.string.set_sign_out_body),
            confirmLabel = stringResource(R.string.home_sign_out),
            destructive = true,
            focusDismiss = true,
            onConfirm = { confirm = false; signOut() },
            onDismiss = { confirm = false },
        )
    }
}

// ─── Cache ─────────────────────────────────────────────────────────────────────

internal fun homeCacheFiles(cacheDir: File): List<File> =
    cacheDir.listFiles { f -> f.isFile && f.name.startsWith("home-") && f.name.endsWith(".json") }?.toList().orEmpty()

@Composable
internal fun CachePane(deps: ScreenDeps) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tick by remember { mutableIntStateOf(0) }
    var mem by remember { mutableStateOf(-1L to -1L) }
    var disk by remember { mutableStateOf(-1L to -1L) }
    var home by remember { mutableStateOf(-1L) }
    var done by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(tick) {
        val loader = SingletonImageLoader.get(context)
        mem = (loader.memoryCache?.size ?: 0L) to (loader.memoryCache?.maxSize ?: 0L)
        withContext(Dispatchers.IO) {
            disk = (loader.diskCache?.size ?: 0L) to (loader.diskCache?.maxSize ?: 0L)
            home = homeCacheFiles(context.cacheDir).sumOf { it.length() }
        }
    }
    val clearedImages = stringResource(R.string.set_cache_images_cleared)
    val clearedHome = stringResource(R.string.set_cache_home_cleared)
    val clearedResume = stringResource(R.string.settings_cleared)

    InfoRow(stringResource(R.string.set_cache_memory), "${formatBytes(mem.first)} / ${formatBytes(mem.second)}")
    InfoRow(stringResource(R.string.set_cache_disk), "${formatBytes(disk.first)} / ${formatBytes(disk.second)}")
    InfoRow(stringResource(R.string.set_cache_home), formatBytes(home))
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SettingRow(stringResource(R.string.set_cache_clear_images), {
            scope.launch {
                val loader = SingletonImageLoader.get(context)
                loader.memoryCache?.clear()
                withContext(Dispatchers.IO) { loader.diskCache?.clear() }
                done = clearedImages; tick++
            }
        })
        SettingRow(stringResource(R.string.set_cache_clear_home), {
            scope.launch {
                withContext(Dispatchers.IO) { homeCacheFiles(context.cacheDir).forEach { it.delete() } }
                deps.media.invalidateHome()
                done = clearedHome; tick++
            }
        })
        SettingRow(stringResource(R.string.settings_clear_progress), {
            scope.launch { deps.settings.clearProgress(); done = clearedResume }
        }, subtitle = stringResource(R.string.set_cache_resume_hint))
    }
    done?.let { Text(it, color = Tokens.success, style = MaterialTheme.typography.bodyMedium) }
}

// ─── Watch Together ────────────────────────────────────────────────────────────

@Composable
internal fun TogetherPane(deps: ScreenDeps) {
    val scope = rememberCoroutineScope()
    val name by deps.settings.deviceName.collectAsState(initial = "")
    var edit by remember { mutableStateOf(false) }
    Text(stringResource(R.string.set_together_hint), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
    SettingRow(stringResource(R.string.set_device_name), { edit = true }, value = name.ifBlank { Build.MODEL }, icon = MixaiIcons.Tv)
    if (name.isNotBlank()) SecondaryButton(stringResource(R.string.set_device_name_reset), { scope.launch { deps.settings.setDeviceName(""); deps.hub.refreshHello() } })
    if (edit) {
        TextEntryDialog(
            title = stringResource(R.string.set_device_name),
            initial = name.ifBlank { Build.MODEL },
            maxLength = 32,
            onDone = { v -> edit = false; scope.launch { deps.settings.setDeviceName(v); deps.hub.refreshHello() } },
            onDismiss = { edit = false },
        )
    }
}

// ─── Your year ─────────────────────────────────────────────────────────────────

@Composable
internal fun StatsPane(nav: Navigator) {
    Text(stringResource(R.string.set_stats_hint), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
    PrimaryButton(stringResource(R.string.stats_open), { nav.push(Route.Stats) }, icon = MixaiIcons.Speed)
}

// ─── About / diagnostics ───────────────────────────────────────────────────────

@Composable
internal fun AboutPane(deps: ScreenDeps) {
    val context = LocalContext.current
    val hub by deps.hub.status.collectAsState()
    var health by remember { mutableStateOf<Probe<Health>>(Probe.Loading) }
    var status by remember { mutableStateOf<Probe<MediaStatus?>>(Probe.Loading) }
    var deviceId by remember { mutableStateOf("") }
    val panel = remember { runCatching { detectPanelAspect(context) }.getOrNull() }
    LaunchedEffect(Unit) {
        deviceId = runCatching { deps.settings.deviceId() }.getOrDefault("")
        health = runCatching { deps.api.health() }.fold({ Probe.Ok(it) }, { Probe.Failed(it.message ?: "") })
        status = runCatching { deps.media.status() }.fold({ Probe.Ok(it) }, { Probe.Failed(it.message ?: "") })
    }
    val checking = stringResource(R.string.settings_server_checking)
    val unknown = stringResource(R.string.set_unknown)
    val yes = stringResource(R.string.set_yes)
    val no = stringResource(R.string.set_no)

    InfoRow(stringResource(R.string.set_about_app), "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
    InfoRow(stringResource(R.string.set_about_server), when (val h = health) { Probe.Loading -> checking; is Probe.Ok -> h.value.version; is Probe.Failed -> unknown })
    InfoRow(
        stringResource(R.string.set_about_hub),
        stringResource(when (hub) { HubStatus.Connected -> R.string.set_hub_connected; HubStatus.Connecting -> R.string.set_hub_connecting; HubStatus.Disconnected -> R.string.set_hub_disconnected }),
        valueColor = when (hub) { HubStatus.Connected -> Tokens.success; HubStatus.Connecting -> Tokens.warning; HubStatus.Disconnected -> Tokens.mutedForeground },
    )
    InfoRow(stringResource(R.string.set_about_device_id), deviceId.ifBlank { unknown })
    InfoRow(stringResource(R.string.set_about_device), "${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}")
    InfoRow(stringResource(R.string.set_about_panel), panel?.let { String.format(Locale.ROOT, "%.2f:1", it) } ?: unknown)
    InfoRow(
        stringResource(R.string.set_about_tmdb),
        when (val s = status) { Probe.Loading -> checking; is Probe.Ok -> if (s.value?.tmdb == true) yes else no; is Probe.Failed -> unknown },
        valueColor = if ((status as? Probe.Ok)?.value?.tmdb == true) Tokens.success else Tokens.foreground,
    )
    (status as? Probe.Ok)?.value?.let { s ->
        InfoRow(stringResource(R.string.set_about_library), s.libraryCount.toString())
        InfoRow(stringResource(R.string.set_about_region), "${s.region} · ${s.language}")
    }
    Box(Modifier.size(1.dp))
}
