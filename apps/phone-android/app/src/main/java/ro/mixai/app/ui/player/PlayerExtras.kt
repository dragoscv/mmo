package ro.mixai.app.ui.player

import android.annotation.SuppressLint
import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.media3.common.util.UnstableApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Request
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.data.Bookmark
import ro.mixai.app.data.BookmarkInput
import ro.mixai.app.data.SubtitleHit
import ro.mixai.app.downloads.DownloadCenter
import ro.mixai.app.downloads.DownloadItem
import ro.mixai.app.downloads.DownloadMeta
import ro.mixai.tv.data.Http
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.ParsedName
import ro.mixai.tv.data.VideoFile

// Player extras (D38): offline copies, scene bookmarks, subtitle search, dual-subtitle loading.

@SuppressLint("UnsafeOptInUsageError")
@UnstableApi
internal fun offlineDownload(fileId: String): DownloadItem? = DownloadCenter.completed(fileId)

/** Minimal VideoFile for an offline copy (no probe data: direct play of the original, no server subtitles). */
internal fun offlineVideoFile(m: DownloadMeta): VideoFile = VideoFile(
    fileId = m.fileId,
    parsed = ParsedName(title = m.title, season = m.season?.toInt(), episode = m.episode?.toInt()),
    container = "matroska",
    videoCodec = "h264",
)

/** `movie:603`, `tv:1399:s1e2`, `file:<id>` (server Bookmark.titleKey). */
internal fun bookmarkKey(ref: MediaRef?, fileId: String): String = when {
    ref == null -> "file:$fileId"
    ref.kind == "tv" && ref.season != null && ref.episode != null -> "tv:${ref.tmdbId}:s${ref.season}e${ref.episode}"
    else -> "${ref.kind}:${ref.tmdbId}"
}

internal fun bookmarkInput(ref: MediaRef?, fileId: String, sec: Double, label: String, shared: Boolean): BookmarkInput =
    if (ref == null) BookmarkInput(fileId = fileId, sec = sec, label = label.ifBlank { null }, shared = shared)
    else BookmarkInput(kind = ref.kind, tmdbId = ref.tmdbId, season = ref.season, episode = ref.episode, sec = sec, label = label.ifBlank { null }, shared = shared)

/** Loads a server WebVTT track (`/video/subs/{id}/{n}`) for the dual-subtitle overlay. */
internal suspend fun loadVtt(url: String): List<VttCue> = withContext(Dispatchers.IO) {
    Http.slow.newCall(Request.Builder().url(url).build()).execute().use { r ->
        if (!r.isSuccessful) emptyList() else Vtt.parse(r.body.string())
    }
}

/** Bookmarks sheet body: add at the current position (label, shared toggle) + list (jump / delete own). */
@Composable
internal fun BookmarksPanel(deps: AppDeps, ref: MediaRef?, fileId: String, positionMs: Long, onJump: (Long) -> Unit) {
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<Bookmark>?>(null) }
    var label by remember { mutableStateOf("") }
    var shared by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf(false) }
    val key = remember(ref, fileId) { bookmarkKey(ref, fileId) }
    LaunchedEffect(key, reload) {
        error = false
        list = runCatching { deps.phoneApi.bookmarks(key) }.onFailure { error = true }.getOrNull() ?: emptyList()
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.bookmark_add_at, formatTime(positionMs)), style = MaterialTheme.typography.titleSmall)
        OutlinedTextField(label, { label = it.take(120) }, singleLine = true, label = { Text(stringResource(R.string.bookmark_label)) }, modifier = Modifier.fillMaxWidth())
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.bookmark_shared), modifier = Modifier.weight(1f))
            Switch(checked = shared, onCheckedChange = { shared = it })
        }
        Button(onClick = {
            val sec = positionMs / 1000.0
            scope.launch {
                runCatching { deps.phoneApi.addBookmark(bookmarkInput(ref, fileId, sec, label, shared)) }
                    .onSuccess { label = ""; reload++ }
                    .onFailure { error = true }
            }
        }) {
            Icon(Icons.Outlined.BookmarkBorder, contentDescription = null)
            Text(stringResource(R.string.bookmark_add), modifier = Modifier.padding(start = 8.dp))
        }
        if (error) Text(stringResource(R.string.bookmark_error), color = MaterialTheme.colorScheme.error)
    }
    val l = list
    if (l == null) CircularProgressIndicator(Modifier.padding(16.dp))
    else if (l.isEmpty()) Text(stringResource(R.string.bookmark_empty), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
    else l.distinctBy { it.id }.forEach { b ->
        ListItem(
            headlineContent = { Text(b.label.ifBlank { formatTime((b.sec * 1000).toLong()) }, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            supportingContent = {
                val who = if (b.mine == false) b.profileName.orEmpty() else ""
                Text(listOf(formatTime((b.sec * 1000).toLong()), who, if (b.shared) stringResource(R.string.bookmark_shared_badge) else "").filter { it.isNotBlank() }.joinToString(" · "))
            },
            trailingContent = {
                if (b.mine != false) IconButton(onClick = { scope.launch { runCatching { deps.phoneApi.deleteBookmark(b.id) }; reload++ } }) {
                    Icon(Icons.Outlined.Delete, contentDescription = stringResource(R.string.bookmark_delete))
                }
            },
            modifier = Modifier.clickable { onJump((b.sec * 1000).toLong()) },
        )
    }
}

/** Search inside this file's subtitles (server FTS); indexes on demand, then jump to a hit. */
@Composable
internal fun SubtitleSearchPanel(deps: AppDeps, fileId: String, onJump: (Long) -> Unit) {
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf("") }
    var hits by remember { mutableStateOf<List<SubtitleHit>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var indexing by remember { mutableStateOf(false) }
    var noIndex by remember { mutableStateOf(false) }
    fun search() {
        if (q.trim().length < 2) return
        busy = true
        scope.launch {
            val r = runCatching { deps.phoneApi.searchSubtitles(q.trim(), fileId) }.getOrNull()
            hits = r?.hits ?: emptyList()
            noIndex = r?.indexedFiles == false
            if (noIndex && !indexing) {
                indexing = true
                runCatching { deps.phoneApi.indexSubtitles(fileId) }
                // Sidecars index at once; embedded tracks take one ffmpeg job: retry a few times.
                repeat(6) {
                    delay(5_000)
                    val again = runCatching { deps.phoneApi.searchSubtitles(q.trim(), fileId) }.getOrNull()
                    if (again != null && again.indexedFiles != false) { hits = again.hits; noIndex = false; return@repeat }
                }
                indexing = false
            }
            busy = false
        }
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(q, { q = it.take(200) }, singleLine = true, label = { Text(stringResource(R.string.subsearch_hint)) }, modifier = Modifier.weight(1f))
            IconButton(onClick = { search() }, enabled = q.trim().length >= 2 && !busy) {
                Icon(Icons.Outlined.Search, contentDescription = stringResource(R.string.subsearch_go))
            }
        }
        if (busy || indexing) Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.padding(end = 8.dp))
            Text(stringResource(if (indexing) R.string.subsearch_indexing else R.string.subsearch_searching))
        }
    }
    val h = hits
    if (h != null && h.isEmpty() && !busy) Text(stringResource(if (noIndex) R.string.subsearch_no_subs else R.string.subsearch_none), modifier = Modifier.padding(16.dp))
    h?.distinctBy { "${it.trackKey}-${it.startSec}" }?.forEach { hit ->
        ListItem(
            headlineContent = { Text(hit.text, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            supportingContent = { Text(listOfNotNull(formatTime((hit.startSec * 1000).toLong()), hit.lang?.uppercase()).joinToString(" · ")) },
            modifier = Modifier.clickable { onJump((hit.startSec * 1000).toLong()) },
        )
    }
}

internal fun Context.toastShort(text: String) = android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_SHORT).show()
