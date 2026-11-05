package ro.mixai.app.ui.downloads

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DownloadForOffline
import androidx.compose.material.icons.outlined.SignalWifi4Bar
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.offline.Download
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.downloads.DownloadCenter
import ro.mixai.app.downloads.DownloadItem
import ro.mixai.app.downloads.SmartDownloadWorker
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.app.ui.components.Chip
import ro.mixai.app.ui.components.EmptyState
import ro.mixai.tv.data.MediaRef
import java.util.Locale

// Per-profile downloads (WP16-46 slice 2, D38): storage gauge, Wi-Fi-only + smart toggles,
// movies as rows and episodes grouped by show then season.

private data class SeasonGroup(val key: String, val season: Long?, val items: List<DownloadItem>)
private data class ShowGroup(val key: String, val title: String, val seasons: List<SeasonGroup>)

@androidx.annotation.OptIn(UnstableApi::class)
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DownloadsScreen(deps: AppDeps, nav: Navigator) {
	val context = LocalContext.current
	val all by DownloadCenter.items.collectAsState()
	val activeProfile by deps.profiles.activeProfile.collectAsState()
	val activeId = activeProfile?.id ?: deps.profiles.activeId
	val wifiOnly by deps.phone.settings.wifiOnly.collectAsState(initial = true)
	val smart by deps.phone.settings.smartDownloads.collectAsState(initial = false)
	var pendingDelete by remember { mutableStateOf<DownloadItem?>(null) }

	val items = remember(all, activeId) {
		all.filter { it.meta.profileId.isBlank() || it.meta.profileId == activeId }.distinctBy { it.id }
	}
	val used = remember(all) { DownloadCenter.usedBytes() }
	val free = remember(all) { runCatching { context.filesDir.usableSpace }.getOrDefault(0L) }
	val movies = remember(items) { items.filter { !isEpisode(it) }.sortedBy { it.meta.title.lowercase() } }
	val shows = remember(items) { groupShows(items.filter { isEpisode(it) }) }

	val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
	Scaffold(
		modifier = Modifier.fillMaxSize().nestedScroll(scrollBehavior.nestedScrollConnection),
		topBar = {
			LargeTopAppBar(
				title = { Text(stringResource(R.string.downloads_title)) },
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
			item(key = "storage") { StorageCard(used, free) }
			item(key = "settings") {
				Section(stringResource(R.string.downloads_section_settings))
				ListItem(
					headlineContent = { Text(stringResource(R.string.downloads_wifi_only)) },
					supportingContent = { Text(stringResource(R.string.downloads_wifi_only_hint)) },
					leadingContent = { Icon(Icons.Outlined.SignalWifi4Bar, contentDescription = null) },
					trailingContent = {
						Switch(checked = wifiOnly, onCheckedChange = { v ->
							deps.scope.launch { deps.phone.settings.setWifiOnly(v) }
							DownloadCenter.setWifiOnly(context, v)
						})
					},
					colors = itemColors(),
				)
				ListItem(
					headlineContent = { Text(stringResource(R.string.downloads_smart)) },
					supportingContent = { Text(stringResource(R.string.downloads_smart_hint)) },
					leadingContent = { Icon(Icons.Outlined.AutoAwesome, contentDescription = null) },
					trailingContent = {
						Switch(checked = smart, onCheckedChange = { v ->
							deps.scope.launch { deps.phone.settings.setSmartDownloads(v) }
							SmartDownloadWorker.schedule(context, v)
						})
					},
					colors = itemColors(),
				)
			}
			if (items.isEmpty()) {
				item(key = "empty") {
					Box(Modifier.fillMaxWidth().height(360.dp)) {
						EmptyState(
							icon = Icons.Outlined.DownloadForOffline,
							title = stringResource(R.string.downloads_empty_title),
							hint = stringResource(R.string.downloads_empty_hint),
						)
					}
				}
			} else {
				item(key = "h-items") { Section(stringResource(R.string.downloads_section_items)) }
				if (movies.isNotEmpty()) {
					item(key = "h-movies") { GroupHeader(stringResource(R.string.downloads_movies)) }
					movies.forEach { d ->
						item(key = "m-${d.id}") {
							DownloadRow(d, d.meta.title, onPlay = { play(nav, d) }, onDelete = { pendingDelete = d })
						}
					}
				}
				shows.forEach { show ->
					item(key = "show-${show.key}") { GroupHeader(show.title) }
					show.seasons.forEach { s ->
						if (s.season != null) {
							item(key = "season-${s.key}") { SeasonHeader(stringResource(R.string.downloads_season, s.season.toInt())) }
						}
						s.items.forEach { d ->
							item(key = "e-${d.id}") {
								val ep = d.meta.episode?.toInt()
								val name = d.meta.episodeName?.takeIf { it.isNotBlank() }
								val title = when {
									ep != null && name != null -> stringResource(R.string.downloads_episode, ep, name)
									ep != null -> stringResource(R.string.downloads_episode_untitled, ep)
									else -> name ?: d.meta.title
								}
								DownloadRow(d, title, onPlay = { play(nav, d) }, onDelete = { pendingDelete = d })
							}
						}
					}
				}
			}
		}
	}

	pendingDelete?.let { d ->
		AlertDialog(
			onDismissRequest = { pendingDelete = null },
			title = { Text(stringResource(R.string.downloads_delete_title)) },
			text = { Text(stringResource(R.string.downloads_delete_body, d.meta.title)) },
			confirmButton = {
				TextButton(onClick = {
					DownloadCenter.remove(context, d.meta.fileId)
					pendingDelete = null
				}) { Text(stringResource(R.string.downloads_delete_confirm)) }
			},
			dismissButton = {
				TextButton(onClick = { pendingDelete = null }) { Text(stringResource(R.string.downloads_cancel)) }
			},
		)
	}
}

private fun isEpisode(d: DownloadItem): Boolean =
	d.meta.kind == "tv" || d.meta.kind == "episode" || d.meta.season != null || d.meta.episode != null

private fun groupShows(episodes: List<DownloadItem>): List<ShowGroup> =
	episodes.groupBy { it.meta.tmdbId?.let { id -> "t$id" } ?: "n${it.meta.title.lowercase()}" }
		.map { (key, list) ->
			val seasons = list.groupBy { it.meta.season }
				.entries.sortedBy { it.key ?: Long.MAX_VALUE }
				.map { (season, eps) ->
					SeasonGroup("$key-${season ?: "x"}", season, eps.sortedBy { it.meta.episode ?: Long.MAX_VALUE })
				}
			ShowGroup(key, list.first().meta.title, seasons)
		}
		.sortedBy { it.title.lowercase() }

@androidx.annotation.OptIn(UnstableApi::class)
private fun play(nav: Navigator, d: DownloadItem) {
	if (!d.completed) return
	val m = d.meta
	val ref = m.tmdbId?.let { MediaRef(m.kind, it, m.season, m.episode) }
	nav.push(Dest.Player(m.fileId, ref, -1L))
}

/** Bytes as "512.0 MB" / "1.2 GB" (one decimal). */
internal fun formatBytes(bytes: Long): String {
	val mb = bytes.coerceAtLeast(0L) / (1024.0 * 1024.0)
	return if (mb >= 1024.0) String.format(Locale.getDefault(), "%.1f GB", mb / 1024.0)
	else String.format(Locale.getDefault(), "%.1f MB", mb)
}

@Composable
private fun StorageCard(used: Long, free: Long) {
	val usedText = formatBytes(used)
	val freeText = formatBytes(free)
	val total = used + free
	val fraction = if (total > 0) (used.toDouble() / total).toFloat().coerceIn(0f, 1f) else 0f
	val cd = stringResource(R.string.downloads_storage_cd, usedText, freeText)
	Card(
		modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).semantics(mergeDescendants = true) { contentDescription = cd },
		colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
	) {
		Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
			Text(stringResource(R.string.downloads_storage_title), style = MaterialTheme.typography.titleMedium)
			LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth())
			Text(
				stringResource(R.string.downloads_storage_line, usedText, freeText),
				style = MaterialTheme.typography.bodyMedium,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
			)
		}
	}
}

@androidx.annotation.OptIn(UnstableApi::class)
@Composable
private fun DownloadRow(d: DownloadItem, title: String, onPlay: () -> Unit, onDelete: () -> Unit) {
	val status = when {
		d.completed -> stringResource(R.string.downloads_status_done, formatBytes(if (d.bytes > 0) d.bytes else d.meta.sizeBytes))
		d.state == Download.STATE_DOWNLOADING -> stringResource(R.string.downloads_status_downloading, d.percent.toInt().coerceIn(0, 100))
		d.state == Download.STATE_FAILED -> stringResource(R.string.downloads_status_failed)
		d.state == Download.STATE_REMOVING -> stringResource(R.string.downloads_status_removing)
		d.state == Download.STATE_STOPPED -> stringResource(R.string.downloads_status_paused)
		d.state == Download.STATE_QUEUED && d.stopReason != Download.STOP_REASON_NONE -> stringResource(R.string.downloads_status_paused)
		else -> stringResource(R.string.downloads_status_queued)
	}
	val failed = d.state == Download.STATE_FAILED
	ListItem(
		headlineContent = { Text(title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
		supportingContent = {
			Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
				Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
					Text(
						status,
						style = MaterialTheme.typography.bodySmall,
						color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
					)
					if (d.meta.smart) Chip(stringResource(R.string.downloads_smart_chip))
				}
				if (d.active) {
					if (d.state == Download.STATE_DOWNLOADING && d.percent > 0f) {
						LinearProgressIndicator(progress = { (d.percent / 100f).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
					} else {
						LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
					}
				}
			}
		},
		leadingContent = { Poster(d.meta.posterUrl) },
		trailingContent = {
			IconButton(onClick = onDelete) {
				Icon(Icons.Outlined.Delete, contentDescription = stringResource(R.string.downloads_delete))
			}
		},
		colors = itemColors(),
		modifier = if (d.completed) Modifier.clickable(onClick = onPlay) else Modifier,
	)
}

@Composable
private fun Poster(url: String?) {
	Box(
		Modifier.width(48.dp).height(72.dp).clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.surfaceVariant),
		contentAlignment = Alignment.Center,
	) {
		if (!url.isNullOrBlank()) {
			AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
		} else {
			Icon(
				Icons.Outlined.DownloadForOffline,
				contentDescription = null,
				tint = MaterialTheme.colorScheme.onSurfaceVariant,
				modifier = Modifier.size(20.dp),
			)
		}
	}
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
			modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
		)
	}
}

@Composable
private fun GroupHeader(title: String) {
	Text(
		title,
		style = MaterialTheme.typography.titleMedium,
		maxLines = 1,
		overflow = TextOverflow.Ellipsis,
		modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
	)
}

@Composable
private fun SeasonHeader(title: String) {
	Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
		Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
		Spacer(Modifier.width(8.dp))
		HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
	}
}
