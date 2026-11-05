package ro.mixai.app.ui.family

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.data.FamilyProfileStats
import ro.mixai.app.data.FamilyStats
import ro.mixai.app.data.ProfileUsage
import ro.mixai.app.nav.Navigator
import ro.mixai.app.ui.components.EmptyState
import ro.mixai.app.ui.components.ErrorState
import ro.mixai.app.ui.components.LoadingSkeleton
import ro.mixai.app.ui.components.ProfileAvatar
import ro.mixai.app.ui.kids.CapUi
import ro.mixai.app.ui.kids.capUiState
import ro.mixai.app.ui.theme.Mixai

/** Localised "1 h 05 min" / "45 min". */
@Composable
fun formatMinutes(minutes: Long): String {
	val m = minutes.coerceAtLeast(0)
	return if (m >= 60) stringResource(R.string.family_hours_minutes, (m / 60).toInt(), (m % 60).toInt())
	else stringResource(R.string.family_minutes, m.toInt())
}

private fun shortWeekday(day: String, locale: Locale): String =
	runCatching { LocalDate.parse(day).dayOfWeek.getDisplayName(TextStyle.SHORT, locale) }.getOrDefault(day.takeLast(2))

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FamilyStatsScreen(deps: AppDeps, nav: Navigator) {
	var stats by remember { mutableStateOf<FamilyStats?>(null) }
	var error by remember { mutableStateOf<Throwable?>(null) }
	var refreshing by remember { mutableStateOf(false) }
	var reload by remember { mutableIntStateOf(0) }

	LaunchedEffect(reload) {
		error = null
		runCatching { deps.phoneApi.familyStats() }
			.onSuccess { stats = it }
			.onFailure { error = it }
		refreshing = false
	}

	val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
	Scaffold(
		modifier = Modifier.fillMaxSize().nestedScroll(scrollBehavior.nestedScrollConnection),
		topBar = {
			LargeTopAppBar(
				title = { Text(stringResource(R.string.family_title)) },
				navigationIcon = {
					IconButton(onClick = { nav.pop() }) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
					}
				},
				scrollBehavior = scrollBehavior,
			)
		},
	) { padding ->
		val current = stats
		val err = error
		Box(Modifier.fillMaxSize().padding(padding)) {
			when {
				current == null && err != null -> ErrorState(err, onRetry = { reload++ })
				current == null -> LoadingSkeleton(hero = false, rows = 3)
				else -> PullToRefreshBox(
					isRefreshing = refreshing,
					onRefresh = { refreshing = true; reload++ },
					modifier = Modifier.fillMaxSize(),
				) {
					if (current.profiles.isEmpty()) {
						EmptyState(
							icon = Icons.Outlined.Groups,
							title = stringResource(R.string.family_empty_title),
							hint = stringResource(R.string.family_empty_hint),
						)
					} else {
						LazyColumn(
							modifier = Modifier.fillMaxSize(),
							contentPadding = PaddingValues(16.dp),
							verticalArrangement = Arrangement.spacedBy(12.dp),
							horizontalAlignment = Alignment.CenterHorizontally,
						) {
							items(current.profiles, key = { it.profileId }) { p ->
								FamilyProfileCard(deps, p, Modifier.widthIn(max = 720.dp).fillMaxWidth())
							}
						}
					}
				}
			}
		}
	}
}

@Composable
private fun FamilyProfileCard(deps: AppDeps, p: FamilyProfileStats, modifier: Modifier = Modifier) {
	val all by deps.profiles.profiles.collectAsState()
	val profile = all.firstOrNull { it.id == p.profileId }
	val isKid = p.kind == "kid"
	Card(modifier) {
		Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
				if (profile != null) {
					ProfileAvatar(profile, size = 44.dp)
				} else {
					Box(
						Modifier.size(44.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
						contentAlignment = Alignment.Center,
					) {
						Text(
							p.name.trim().take(1).uppercase(),
							style = MaterialTheme.typography.titleMedium,
							color = MaterialTheme.colorScheme.onPrimaryContainer,
						)
					}
				}
				Text(p.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
				if (isKid) {
					Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer) {
						Text(
							stringResource(R.string.family_kid_badge),
							style = MaterialTheme.typography.labelMedium,
							color = MaterialTheme.colorScheme.onSecondaryContainer,
							modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
						)
					}
				}
			}
			Text(
				stringResource(R.string.family_week_line, formatMinutes(p.weeklyWatchMin), formatMinutes(p.weeklyListenMin)),
				style = MaterialTheme.typography.bodyMedium,
			)
			val cap = p.dailyCapMin
			if (isKid && cap != null && cap > 0) {
				Text(
					stringResource(R.string.family_today_cap_line, formatMinutes(p.todayWatchMin), formatMinutes(cap)),
					style = MaterialTheme.typography.bodyMedium,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
				val frac = (p.todayWatchMin.toFloat() / cap.toFloat()).coerceIn(0f, 1f)
				LinearProgressIndicator(progress = { frac }, modifier = Modifier.fillMaxWidth())
				val usage = ProfileUsage(
					profileId = p.profileId,
					watchMin = p.todayWatchMin,
					dailyCapMin = cap,
					overCap = p.overCap,
					enforced = true,
				)
				when (val state = capUiState(usage, isKid = true)) {
					is CapUi.Remaining -> Text(
						stringResource(R.string.family_left_today, state.minutes.toInt()),
						style = MaterialTheme.typography.bodySmall,
						color = if (state.low) Mixai.colors.warning else MaterialTheme.colorScheme.onSurfaceVariant,
					)
					is CapUi.Locked -> Text(
						stringResource(R.string.family_limit_reached),
						style = MaterialTheme.typography.bodySmall,
						color = Mixai.colors.warning,
					)
					CapUi.Hidden -> Unit
				}
			} else {
				Text(
					stringResource(R.string.family_today_line, formatMinutes(p.todayWatchMin)),
					style = MaterialTheme.typography.bodyMedium,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			if (p.days.isNotEmpty()) {
				Spacer(Modifier.height(4.dp))
				WeekChart(p)
			}
		}
	}
}

@Composable
private fun WeekChart(p: FamilyProfileStats) {
	val locale = Locale.getDefault()
	val n = p.days.size
	val watch = List(n) { p.watchMin.getOrNull(it) ?: 0L }
	val listen = List(n) { p.listenMin.getOrNull(it) ?: 0L }
	val labels = p.days.map { shortWeekday(it, locale) }
	val dayParts = List(n) { i ->
		stringResource(R.string.family_chart_day, labels[i], formatMinutes(watch[i]), formatMinutes(listen[i]))
	}
	val summary = stringResource(R.string.family_chart_desc, p.name, dayParts.joinToString("; "))
	val primary = MaterialTheme.colorScheme.primary
	val secondary = MaterialTheme.colorScheme.secondary
	val track = MaterialTheme.colorScheme.surfaceVariant
	val max = (0 until n).maxOfOrNull { watch[it] + listen[it] }?.coerceAtLeast(1L) ?: 1L

	Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = summary }) {
		Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
			Text(stringResource(R.string.family_chart_title), style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
			LegendDot(primary)
			Text(stringResource(R.string.family_legend_watch), style = MaterialTheme.typography.labelSmall)
			LegendDot(secondary)
			Text(stringResource(R.string.family_legend_listen), style = MaterialTheme.typography.labelSmall)
		}
		Spacer(Modifier.height(8.dp))
		Canvas(Modifier.fillMaxWidth().height(72.dp)) {
			val slot = size.width / n
			val barW = slot * 0.55f
			val radius = CornerRadius(barW / 4f, barW / 4f)
			for (i in 0 until n) {
				val x = slot * i + (slot - barW) / 2f
				drawRoundRect(track, topLeft = Offset(x, 0f), size = Size(barW, size.height), cornerRadius = radius)
				val wH = size.height * (watch[i].toFloat() / max)
				val lH = size.height * (listen[i].toFloat() / max)
				if (wH > 0f) drawRoundRect(primary, topLeft = Offset(x, size.height - wH), size = Size(barW, wH), cornerRadius = radius)
				if (lH > 0f) drawRoundRect(secondary, topLeft = Offset(x, size.height - wH - lH), size = Size(barW, lH), cornerRadius = radius)
			}
		}
		Spacer(Modifier.height(4.dp))
		Row(Modifier.fillMaxWidth()) {
			labels.forEach { label ->
				Text(
					label,
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					textAlign = TextAlign.Center,
					maxLines = 1,
					modifier = Modifier.weight(1f),
				)
			}
		}
	}
}

@Composable
private fun LegendDot(color: androidx.compose.ui.graphics.Color) {
	Box(Modifier.size(8.dp).background(color, CircleShape))
}
