package ro.mixai.app.ui.title

import android.annotation.SuppressLint
import android.util.Log
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bookmark
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.Tv
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.media3.common.util.UnstableApi
import kotlinx.coroutines.launch
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.data.Bookmark
import ro.mixai.app.downloads.DownloadCenter
import ro.mixai.app.downloads.DownloadMeta
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.app.ui.media.PlayTarget
import ro.mixai.app.ui.playon.PlayOnRequest
import ro.mixai.app.ui.playon.PlayOnSheet
import ro.mixai.app.ui.player.formatTime
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.TmdbSize
import ro.mixai.tv.data.generated.MediaTitleResponse

/** Download (original file), Play on TV, Follow (smart downloads) for the current play target. */
@SuppressLint("UnsafeOptInUsageError")
@OptIn(ExperimentalLayoutApi::class, UnstableApi::class)
@Composable
internal fun TitleExtras(deps: AppDeps, d: MediaTitleResponse, target: PlayTarget?, isTv: Boolean, kind: String) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val items by DownloadCenter.items.collectAsState()
    val followed by deps.phone.settings.followedShows.collectAsState(initial = emptySet())
    var playOn by remember { mutableStateOf(false) }
    val t = d.title
    val dl = target?.let { tg -> items.firstOrNull { it.meta.fileId == tg.fileId } }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (target != null) {
            FilledTonalButton(
                onClick = {
                    if (dl != null) return@FilledTonalButton
                    val file = d.files.firstOrNull { it.serverFileId == target.fileId }
                    val meta = DownloadMeta(
                        fileId = target.fileId, title = t.title, kind = t.kind.ifBlank { kind }, tmdbId = t.tmdbId,
                        season = target.ref.season, episode = target.ref.episode,
                        posterUrl = deps.api.tmdbImageUrl(TmdbSize.poster(342), t.posterPath),
                        profileId = deps.profiles.activeId, smart = false, sizeBytes = file?.size ?: 0L,
                    )
                    DownloadCenter.start(context, deps.phoneApi.originalFileUrl(target.fileId), meta)
                    Toast.makeText(context, context.getString(R.string.title_download_started), Toast.LENGTH_SHORT).show()
                },
            ) {
                Icon(if (dl?.completed == true) Icons.Outlined.CheckCircle else Icons.Outlined.Download, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    when {
                        dl == null -> stringResource(R.string.title_download)
                        dl.completed -> stringResource(R.string.title_downloaded)
                        else -> stringResource(R.string.title_downloading, dl.percent.toInt())
                    },
                )
            }
            FilledTonalButton(onClick = { playOn = true }) {
                Icon(Icons.Outlined.Tv, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.playon_button))
            }
        }
        if (isTv) {
            val on = t.tmdbId in followed
            FilledTonalButton(onClick = {
                scope.launch {
                    deps.phone.settings.setFollowed(t.tmdbId, !on)
                    Log.i("SmartDownloads", "follow ${t.tmdbId} -> ${!on}")
                }
            }) {
                Icon(if (on) Icons.Outlined.NotificationsActive else Icons.Outlined.NotificationsNone, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(if (on) R.string.title_following else R.string.title_follow))
            }
        }
    }
    if (playOn && target != null) {
        val startSec = if (target.resumeMs > 0) target.resumeMs / 1000.0 else 0.0
        PlayOnSheet(deps, PlayOnRequest(target.fileId, startSec, target.ref, t.title), onDismiss = { playOn = false })
    }
}

/** Scene bookmarks of this title (own + shared by the household); tap jumps into the player. */
@Composable
internal fun TitleBookmarks(deps: AppDeps, nav: Navigator, d: MediaTitleResponse, kind: String) {
    val t = d.title
    var list by remember { mutableStateOf<List<Bookmark>>(emptyList()) }
    LaunchedEffect(t.kind, t.tmdbId) {
        list = runCatching { deps.phoneApi.bookmarks("${t.kind.ifBlank { kind }}:${t.tmdbId}") }.getOrDefault(emptyList())
    }
    if (list.isEmpty()) return
    Column(Modifier.padding(horizontal = 0.dp)) {
        Text(stringResource(R.string.bookmark_title), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 16.dp))
        list.distinctBy { it.id }.take(12).forEach { b ->
            val fileId = b.fileId ?: d.files.firstOrNull { f -> (b.season == null || f.season == b.season) && (b.episode == null || f.episode == b.episode) }?.serverFileId
            ListItem(
                headlineContent = { Text(b.label.ifBlank { formatTime((b.sec * 1000).toLong()) }) },
                supportingContent = {
                    val ep = if (b.season != null && b.episode != null) "S${b.season} E${b.episode} · " else ""
                    Text(ep + formatTime((b.sec * 1000).toLong()) + (b.profileName?.takeIf { b.mine == false }?.let { " · $it" } ?: ""))
                },
                leadingContent = { Icon(Icons.Outlined.Bookmark, contentDescription = null) },
                modifier = Modifier.clickable(enabled = fileId != null) {
                    val ref = MediaRef(t.kind.ifBlank { kind }, t.tmdbId, b.season, b.episode)
                    nav.push(Dest.Player(fileId!!, ref, (b.sec * 1000).toLong().coerceAtLeast(1L)))
                },
            )
        }
    }
}
