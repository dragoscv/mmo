package ro.mixai.app.ui.settings

import android.content.Intent
import android.os.Build
import android.provider.Settings as AndroidSettings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.BugReport
import androidx.compose.material.icons.outlined.CloudDownload
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.DownloadForOffline
import androidx.compose.material.icons.outlined.FamilyRestroom
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.LiveTv
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.SettingsRemote
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ro.mixai.app.AppDeps
import ro.mixai.app.BuildConfig
import ro.mixai.app.R
import ro.mixai.app.data.ProfileUsage
import ro.mixai.app.downloads.DownloadCenter
import ro.mixai.app.downloads.SmartDownloadWorker
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.mobile.ui.ProfileAvatar
import ro.mixai.app.ui.kids.capRemainingLabel
import ro.mixai.app.ui.kids.capUiState
import ro.mixai.tv.data.isKid

private sealed interface Confirm {
    data object SignOut : Confirm
    data object ChangeServer : Confirm
}

@OptIn(ExperimentalMaterial3Api::class)
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
fun SettingsScreen(deps: AppDeps, nav: Navigator) {
    val context = LocalContext.current
    val profile by deps.profiles.activeProfile.collectAsState()
    val locale by deps.settings.locale.collectAsState(initial = deps.localeTag)
    val deviceName by deps.settings.deviceName.collectAsState(initial = "")
    val phoneSettings = deps.phone.settings
    val dataSaver by phoneSettings.dataSaver.collectAsState(initial = true)
    val wifiOnly by phoneSettings.wifiOnly.collectAsState(initial = true)
    val smartDownloads by phoneSettings.smartDownloads.collectAsState(initial = false)
    val nightMode by phoneSettings.nightMode.collectAsState(initial = false)
    var kidUsage by remember { mutableStateOf<ProfileUsage?>(null) }
    var serverVersion by remember { mutableStateOf<String?>(null) }
    var serverError by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<Confirm?>(null) }
    var languageOpen by remember { mutableStateOf(false) }
    var nameOpen by remember { mutableStateOf(false) }

    LaunchedEffect(deps.api) {
        serverError = false
        runCatching { deps.api.health() }
            .onSuccess { serverVersion = it.version }
            .onFailure { serverError = true }
    }

    val activeProfile = profile
    LaunchedEffect(activeProfile?.id, activeProfile?.isKid) {
        kidUsage = null
        if (activeProfile != null && activeProfile.isKid) {
            kidUsage = runCatching { deps.phoneApi.usage(activeProfile.id) }.getOrNull()
        }
    }
    val kidRemaining = capRemainingLabel(capUiState(kidUsage, activeProfile?.isKid == true))

    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    Scaffold(
        modifier = Modifier.fillMaxSize().nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = {
                    IconButton(onClick = { nav.pop() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                },
                scrollBehavior = scrollBehavior,
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item(key = "profile") {
                Section(stringResource(R.string.settings_section_profile))
                ListItem(
                    headlineContent = { Text(profile?.name ?: stringResource(R.string.settings_profile_none)) },
                    supportingContent = {
                        Column {
                            if (kidRemaining != null) Text(kidRemaining, color = MaterialTheme.colorScheme.primary)
                            Text(stringResource(R.string.settings_profile_switch))
                        }
                    },
                    leadingContent = { ProfileAvatar(profile, size = 44.dp) },
                    trailingContent = { Icon(Icons.Outlined.SwapHoriz, contentDescription = null) },
                    colors = itemColors(),
                    modifier = Modifier.clickable { nav.push(Dest.ProfilePicker) },
                )
            }
            item(key = "watch") {
                Section(stringResource(R.string.settings2_section_watch))
                SettingRow(Icons.Outlined.DownloadForOffline, stringResource(R.string.settings2_downloads), onClick = { nav.push(Dest.Downloads) })
                SettingRow(Icons.Outlined.SettingsRemote, stringResource(R.string.settings2_remote), onClick = { nav.push(Dest.Remote()) })
                SettingRow(Icons.Outlined.Groups, stringResource(R.string.settings2_together), onClick = { nav.push(Dest.Together()) })
                SettingRow(Icons.Outlined.FamilyRestroom, stringResource(R.string.settings2_family), onClick = { nav.push(Dest.FamilyStats) })
                SettingRow(Icons.Outlined.CloudDownload, stringResource(R.string.settings2_plex_import), onClick = { nav.push(Dest.PlexImport) })
            }
            item(key = "playback") {
                Section(stringResource(R.string.settings2_section_playback))
                SwitchRow(
                    title = stringResource(R.string.settings2_data_saver),
                    subtitle = stringResource(R.string.settings2_data_saver_desc),
                    checked = dataSaver,
                    onCheckedChange = { v -> deps.scope.launch { phoneSettings.setDataSaver(v) } },
                )
                SwitchRow(
                    title = stringResource(R.string.settings2_wifi_only),
                    subtitle = stringResource(R.string.settings2_wifi_only_desc),
                    checked = wifiOnly,
                    onCheckedChange = { v ->
                        deps.scope.launch { phoneSettings.setWifiOnly(v) }
                        DownloadCenter.setWifiOnly(context.applicationContext, v)
                    },
                )
                SwitchRow(
                    title = stringResource(R.string.settings2_smart_downloads),
                    subtitle = stringResource(R.string.settings2_smart_downloads_desc),
                    checked = smartDownloads,
                    onCheckedChange = { v ->
                        deps.scope.launch { phoneSettings.setSmartDownloads(v) }
                        SmartDownloadWorker.schedule(context.applicationContext, v)
                    },
                )
                SwitchRow(
                    title = stringResource(R.string.settings2_night_mode),
                    subtitle = stringResource(R.string.settings2_night_mode_desc),
                    checked = nightMode,
                    onCheckedChange = { v -> deps.scope.launch { phoneSettings.setNightMode(v) } },
                )
            }
            item(key = "notifications") {
                SettingRow(
                    icon = Icons.Outlined.Notifications,
                    title = stringResource(R.string.settings2_notifications),
                    subtitle = stringResource(R.string.settings2_notifications_desc),
                    onClick = {
                        val intent = Intent(AndroidSettings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(AndroidSettings.EXTRA_APP_PACKAGE, context.packageName)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        runCatching { context.startActivity(intent) }
                    },
                )
            }
            item(key = "privacy") {
                Section(stringResource(R.string.settings2_section_privacy))
                SettingRow(
                    icon = Icons.Outlined.BugReport,
                    title = stringResource(R.string.settings2_crash_reports),
                    subtitle = if (BuildConfig.SENTRY_DSN.isBlank()) stringResource(R.string.settings2_crash_off)
                    else stringResource(R.string.settings2_crash_on),
                )
            }
            item(key = "account") {
                Section(stringResource(R.string.settings_section_account))
                val signedIn = deps.session.sessionToken.isNotBlank()
                SettingRow(
                    icon = Icons.Outlined.AccountCircle,
                    title = if (signedIn) deps.session.displayName else stringResource(R.string.settings_account_none),
                    subtitle = if (signedIn) stringResource(R.string.settings_account_signed_in) else null,
                )
                val signOut = deps.onSignOut
                if (signOut != null) SettingRow(
                    icon = Icons.AutoMirrored.Outlined.Logout,
                    title = stringResource(R.string.settings_sign_out),
                    onClick = { confirm = Confirm.SignOut },
                )
            }
            item(key = "server") {
                Section(stringResource(R.string.settings_section_server))
                SettingRow(
                    icon = Icons.Outlined.Dns,
                    title = deps.api.baseUrl,
                    subtitle = when {
                        serverError -> stringResource(R.string.settings_server_unreachable)
                        serverVersion == null -> stringResource(R.string.settings_server_checking)
                        serverVersion.isNullOrBlank() -> stringResource(R.string.settings_server_online)
                        else -> stringResource(R.string.settings_server_version, serverVersion.orEmpty())
                    },
                )
                SettingRow(
                    icon = Icons.Outlined.SwapHoriz,
                    title = stringResource(R.string.settings_change_server),
                    onClick = { confirm = Confirm.ChangeServer },
                )
            }
            item(key = "device") {
                Section(stringResource(R.string.settings_section_device))
                SettingRow(
                    icon = Icons.Outlined.Language,
                    title = stringResource(R.string.settings_language),
                    subtitle = languageLabel(locale),
                    onClick = { languageOpen = true },
                )
                SettingRow(
                    icon = Icons.Outlined.PhoneAndroid,
                    title = stringResource(R.string.settings_device_name),
                    subtitle = deviceName.ifBlank { Build.MODEL.orEmpty() },
                    onClick = { nameOpen = true },
                )
            }
            item(key = "about") {
                Section(stringResource(R.string.settings_section_about))
                SettingRow(
                    icon = Icons.Outlined.Info,
                    title = stringResource(R.string.settings_version, BuildConfig.VERSION_NAME),
                    subtitle = stringResource(R.string.settings_licences),
                )
                SettingRow(
                    icon = Icons.Outlined.LiveTv,
                    title = stringResource(R.string.settings_live_tv_title),
                    subtitle = stringResource(R.string.settings_live_tv_notice),
                )
            }
        }
    }

    when (confirm) {
        Confirm.SignOut -> ConfirmDialog(
            title = stringResource(R.string.settings_sign_out_confirm_title),
            text = stringResource(R.string.settings_sign_out_confirm_text),
            confirmLabel = stringResource(R.string.settings_sign_out),
            onConfirm = { confirm = null; deps.onSignOut?.invoke() },
            onDismiss = { confirm = null },
        )
        Confirm.ChangeServer -> ConfirmDialog(
            title = stringResource(R.string.settings_change_server_confirm_title),
            text = stringResource(R.string.settings_change_server_confirm_text),
            confirmLabel = stringResource(R.string.settings_change_server),
            onConfirm = { confirm = null; deps.onChangeServer() },
            onDismiss = { confirm = null },
        )
        null -> Unit
    }

    if (languageOpen) LanguageDialog(
        current = locale,
        onPick = { tag ->
            languageOpen = false
            deps.scope.launch { deps.settings.setLocale(tag) }
        },
        onDismiss = { languageOpen = false },
    )

    if (nameOpen) DeviceNameDialog(
        current = deviceName,
        placeholder = Build.MODEL.orEmpty(),
        onSave = { name ->
            nameOpen = false
            deps.scope.launch { deps.settings.setDeviceName(name) }
        },
        onDismiss = { nameOpen = false },
    )
}

@Composable
private fun itemColors() = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface)

@Composable
private fun Section(title: String) {
    Column(Modifier.fillMaxWidth()) {
        HorizontalDivider(Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
        Text(
            title,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 4.dp),
        )
    }
}

@Composable
private fun SettingRow(icon: ImageVector, title: String, subtitle: String? = null, onClick: (() -> Unit)? = null) {
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = if (subtitle != null) { { Text(subtitle) } } else null,
        leadingContent = { Icon(icon, contentDescription = null) },
        colors = itemColors(),
        modifier = if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier,
    )
}

@Composable
private fun languageLabel(tag: String): String = when (tag) {
    "ro" -> stringResource(R.string.settings_language_ro)
    "en" -> stringResource(R.string.settings_language_en)
    else -> stringResource(R.string.settings_language_system)
}

@Composable
private fun SwitchRow(title: String, subtitle: String?, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = if (subtitle != null) { { Text(subtitle) } } else null,
        trailingContent = { Switch(checked = checked, onCheckedChange = null) },
        colors = itemColors(),
        modifier = Modifier.toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange),
    )
}

@Composable
private fun ConfirmDialog(title: String, text: String, confirmLabel: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = { TextButton(onClick = onConfirm) { Text(confirmLabel) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@Composable
private fun LanguageDialog(current: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val options = listOf("", "ro", "en")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_language)) },
        text = {
            Column {
                options.forEach { tag ->
                    ListItem(
                        headlineContent = { Text(languageLabel(tag)) },
                        leadingContent = { RadioButton(selected = current == tag, onClick = null) },
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
                        modifier = Modifier.selectable(selected = current == tag, role = Role.RadioButton, onClick = { onPick(tag) }),
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_close)) } },
    )
}

@Composable
private fun DeviceNameDialog(current: String, placeholder: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf(current) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_device_name)) },
        text = {
            Column {
                Text(stringResource(R.string.settings_device_name_hint), style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it.take(40) },
                    singleLine = true,
                    placeholder = { Text(placeholder) },
                    modifier = Modifier.fillMaxWidth().widthIn(max = 480.dp).padding(top = 12.dp),
                )
            }
        },
        confirmButton = { TextButton(onClick = { onSave(text) }) { Text(stringResource(R.string.settings_save)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}
