package ro.mixai.mobile.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import ro.mixai.mobile.R
import ro.mixai.tv.data.ApiException
import ro.mixai.tv.data.DeviceAuthException

/** Pulsing placeholder block. */
@Composable
fun SkeletonBox(modifier: Modifier = Modifier) {
    val t = rememberInfiniteTransition(label = "skeleton")
    val a by t.animateFloat(0.35f, 0.7f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "a")
    Box(modifier.clip(MaterialTheme.shapes.small).alpha(a).background(MaterialTheme.colorScheme.surfaceContainerHighest))
}

/** Hero + poster rows skeleton (Home, Title, Library first frame without cache). */
@Composable
fun LoadingSkeleton(modifier: Modifier = Modifier, hero: Boolean = true, rows: Int = 3, cardWidth: Dp = 120.dp) {
    Column(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        if (hero) SkeletonBox(Modifier.fillMaxWidth().aspectRatio(0.9f))
        repeat(rows) {
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SkeletonBox(Modifier.width(140.dp).height(18.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    repeat(4) { SkeletonBox(Modifier.width(cardWidth).aspectRatio(2f / 3f)) }
                }
            }
        }
    }
}

/** Centered icon + title + hint + optional action. */
@Composable
fun EmptyState(icon: ImageVector, title: String, hint: String? = null, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Column(
        modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(56.dp))
        Spacer(Modifier.height(16.dp))
        Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        if (hint != null) {
            Spacer(Modifier.height(8.dp))
            Text(hint, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
        if (action != null) { Spacer(Modifier.height(20.dp)); action() }
    }
}

/** Error with Retry. */
@Composable
fun ErrorState(error: Throwable?, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    EmptyState(
        icon = Icons.Outlined.ErrorOutline,
        title = stringResource(R.string.common_error_title),
        hint = errorText(error),
        modifier = modifier,
    ) {
        Button(onClick = onRetry) { Text(stringResource(R.string.common_action_retry)) }
    }
}

/** Localised message for a failure (network / HTTP status / other). */
@Composable
fun errorText(e: Throwable?): String = when (e) {
    null -> stringResource(R.string.error_generic)
    is DeviceAuthException -> when (e.kind) {
        DeviceAuthException.Kind.Network -> stringResource(R.string.signin_err_network, e.host)
        DeviceAuthException.Kind.Status -> stringResource(R.string.signin_err_status, e.host, e.status)
        DeviceAuthException.Kind.Invalid -> stringResource(R.string.signin_err_invalid, e.host)
    }
    is ApiException -> when (e.status) {
        401, 403 -> stringResource(R.string.error_unauthorized)
        404 -> stringResource(R.string.error_not_found)
        else -> stringResource(R.string.error_http, e.status)
    }
    is java.io.IOException -> stringResource(R.string.error_network)
    else -> e.message ?: e.javaClass.simpleName
}
