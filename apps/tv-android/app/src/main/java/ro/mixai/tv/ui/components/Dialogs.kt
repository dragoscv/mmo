package ro.mixai.tv.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import ro.mixai.tv.R
import ro.mixai.tv.ui.theme.Tokens

/** Centered confirm dialog. The confirm button is focused unless [focusDismiss]. */
@Composable
fun ConfirmDialog(
    title: String,
    message: String?,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    dismissLabel: String = stringResource(R.string.wp16_cancel),
    destructive: Boolean = false,
    focusDismiss: Boolean = false,
) {
    val confirmFocus = remember { FocusRequester() }
    val dismissFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(80); runCatching { (if (focusDismiss) dismissFocus else confirmFocus).requestFocus() } }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.widthIn(min = 420.dp, max = 640.dp).background(Tokens.popover, RoundedCornerShape(16.dp)).padding(32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(title, style = MaterialTheme.typography.headlineSmall, color = if (destructive) Tokens.destructive else Tokens.popoverForeground)
            if (!message.isNullOrBlank()) Text(message, style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                PrimaryButton(confirmLabel, onConfirm, Modifier.focusRequester(confirmFocus))
                SecondaryButton(dismissLabel, onDismiss, Modifier.focusRequester(dismissFocus))
            }
        }
    }
}

/** One choice of a [ChoiceDialog]. */
data class Choice<T>(val value: T, val label: String, val description: String? = null)

/**
 * Right-hand side panel with a list of choices (audio/subtitle tracks, quality, settings values).
 * Focus starts on the [selected] item; Back or picking closes it.
 */
@Composable
fun <T> ChoiceDialog(
    title: String,
    options: List<Choice<T>>,
    selected: T?,
    onPick: (T) -> Unit,
    onDismiss: () -> Unit,
    visible: Boolean = true,
) {
    // Leave composition at once when hidden: an exit animation kept the focused items alive and
    // focus fell back to the screen root instead of the button that opened the panel.
    if (!visible) return
    BackHandler(enabled = visible, onBack = onDismiss)
    AnimatedVisibility(visible, enter = fadeIn(), exit = fadeOut()) {
        Box(Modifier.fillMaxSize().background(Tokens.background.copy(alpha = 0.55f))) {
            AnimatedVisibility(
                visible,
                modifier = Modifier.align(Alignment.CenterEnd),
                enter = slideInHorizontally { it / 2 } + fadeIn(),
                exit = slideOutHorizontally { it / 2 } + fadeOut(),
            ) {
                SidePanelContent(title, options, selected, onPick)
            }
        }
    }
}

@Composable
private fun <T> SidePanelContent(title: String, options: List<Choice<T>>, selected: T?, onPick: (T) -> Unit) {
    val focus = remember { FocusRequester() }
    val selIndex = options.indexOfFirst { it.value == selected }.coerceAtLeast(0)
    LaunchedEffect(options) { delay(80); runCatching { focus.requestFocus() } }
    Column(
        Modifier.width(440.dp).fillMaxHeight().background(Tokens.popover).padding(vertical = 40.dp, horizontal = 24.dp).focusGroup(),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(title, style = MaterialTheme.typography.headlineSmall, color = Tokens.popoverForeground, modifier = Modifier.padding(horizontal = 12.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            itemsIndexed(options) { i, o ->
                val isSel = o.value == selected
                Surface(
                    onClick = { onPick(o.value) },
                    modifier = Modifier.fillMaxWidth().let { if (i == selIndex) it.focusRequester(focus) else it },
                    shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(10.dp)),
                    colors = ClickableSurfaceDefaults.colors(
                        containerColor = androidx.compose.ui.graphics.Color.Transparent,
                        contentColor = Tokens.popoverForeground,
                        focusedContainerColor = Tokens.foreground,
                        focusedContentColor = Tokens.background,
                    ),
                    scale = ClickableSurfaceDefaults.scale(focusedScale = 1.02f),
                ) {
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(28.dp)) { if (isSel) Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(22.dp)) }
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text(o.label, style = MaterialTheme.typography.titleSmall)
                            if (!o.description.isNullOrBlank()) Text(o.description, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
}
