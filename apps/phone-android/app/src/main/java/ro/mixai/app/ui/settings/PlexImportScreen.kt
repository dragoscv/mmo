package ro.mixai.app.ui.settings

import android.util.Log
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.data.PlexImportResult
import ro.mixai.app.nav.Navigator
import ro.mixai.tv.data.ApiException

/** Failure of the Plex import, mapped to a string resource (pure). */
private sealed interface PlexError {
	data class Http(val status: Int) : PlexError
	data object Network : PlexError
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlexImportScreen(deps: AppDeps, nav: Navigator) {
	val scope = rememberCoroutineScope()
	val activeProfile by deps.profiles.activeProfile.collectAsState()
	var url by rememberSaveable { mutableStateOf("") }
	// Token deliberately NOT saveable: it must not survive in the saved-state bundle.
	var token by remember { mutableStateOf("") }
	var showToken by remember { mutableStateOf(false) }
	var running by remember { mutableStateOf(false) }
	var result by remember { mutableStateOf<PlexImportResult?>(null) }
	var failure by remember { mutableStateOf<PlexError?>(null) }

	fun startImport() {
		if (running || url.isBlank() || token.isBlank()) return
		val serverUrl = url.trim()
		val plexToken = token.trim()
		val profileId = deps.profiles.activeId
		running = true
		result = null
		failure = null
		scope.launch {
			try {
				val r = deps.phoneApi.importPlex(serverUrl, plexToken, profileId)
				Log.i("MixaiPlex", "import done movies=${r.watchedMovies} episodes=${r.watchedEpisodes}")
				result = r
			} catch (e: CancellationException) {
				throw e
			} catch (e: ApiException) {
				failure = PlexError.Http(e.status)
			} catch (e: Exception) {
				failure = PlexError.Network
			} finally {
				token = ""
				showToken = false
				running = false
			}
		}
	}

	val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
	Scaffold(
		modifier = Modifier.fillMaxSize().nestedScroll(scrollBehavior.nestedScrollConnection),
		topBar = {
			LargeTopAppBar(
				title = { Text(stringResource(R.string.plex_title)) },
				navigationIcon = {
					IconButton(onClick = { nav.pop() }) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
					}
				},
				scrollBehavior = scrollBehavior,
			)
		},
	) { padding ->
		Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
			Column(
				Modifier.widthIn(max = 640.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
				verticalArrangement = Arrangement.spacedBy(16.dp),
			) {
				Text(stringResource(R.string.plex_intro), style = MaterialTheme.typography.bodyLarge)
				activeProfile?.name?.takeIf { it.isNotBlank() }?.let {
					Text(
						stringResource(R.string.plex_profile_line, it),
						style = MaterialTheme.typography.bodyMedium,
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
				Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh)) {
					Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
						Text(stringResource(R.string.plex_token_hint_title), style = MaterialTheme.typography.titleSmall)
						Text(
							stringResource(R.string.plex_token_hint),
							style = MaterialTheme.typography.bodyMedium,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
				}
				OutlinedTextField(
					value = url,
					onValueChange = { url = it },
					label = { Text(stringResource(R.string.plex_server_url)) },
					placeholder = { Text(stringResource(R.string.plex_server_url_placeholder)) },
					singleLine = true,
					enabled = !running,
					keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
					modifier = Modifier.fillMaxWidth(),
				)
				OutlinedTextField(
					value = token,
					onValueChange = { token = it },
					label = { Text(stringResource(R.string.plex_token)) },
					singleLine = true,
					enabled = !running,
					visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
					keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done, autoCorrectEnabled = false),
					keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { startImport() }),
					trailingIcon = {
						IconButton(onClick = { showToken = !showToken }) {
							Icon(
								if (showToken) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
								contentDescription = stringResource(if (showToken) R.string.plex_token_hide else R.string.plex_token_show),
							)
						}
					},
					modifier = Modifier.fillMaxWidth(),
				)
				Button(
					onClick = { startImport() },
					enabled = !running && url.isNotBlank() && token.isNotBlank(),
					modifier = Modifier.fillMaxWidth(),
				) {
					Text(stringResource(R.string.plex_import_action))
				}
				if (running) {
					Row(
						verticalAlignment = Alignment.CenterVertically,
						horizontalArrangement = Arrangement.spacedBy(12.dp),
						modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
					) {
						CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 3.dp)
						Text(stringResource(R.string.plex_importing), style = MaterialTheme.typography.bodyMedium)
					}
				}
				failure?.let { f ->
					val msg = when (f) {
						PlexError.Network -> stringResource(R.string.plex_error_network)
						is PlexError.Http -> when (f.status) {
							400 -> stringResource(R.string.plex_error_400)
							401 -> stringResource(R.string.plex_error_401)
							403 -> stringResource(R.string.plex_error_403)
							404 -> stringResource(R.string.plex_error_404)
							502 -> stringResource(R.string.plex_error_502)
							else -> stringResource(R.string.plex_error_generic, f.status)
						}
					}
					Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
						Text(
							msg,
							style = MaterialTheme.typography.bodyMedium,
							color = MaterialTheme.colorScheme.onErrorContainer,
							modifier = Modifier.padding(16.dp).semantics { liveRegion = LiveRegionMode.Assertive },
						)
					}
				}
				result?.let { PlexResultCard(it) }
			}
		}
	}
}

@Composable
private fun PlexResultCard(r: PlexImportResult) {
	Card(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) {
		Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			Text(stringResource(R.string.plex_result_title), style = MaterialTheme.typography.titleMedium)
			CountRow(stringResource(R.string.plex_result_sections), r.sections)
			CountRow(stringResource(R.string.plex_result_movies), r.watchedMovies)
			CountRow(stringResource(R.string.plex_result_episodes), r.watchedEpisodes)
			CountRow(stringResource(R.string.plex_result_ratings), r.ratings)
			CountRow(stringResource(R.string.plex_result_watchlist), r.watchlist)
			CountRow(stringResource(R.string.plex_result_unmatched), r.unmatched)
			if (r.errors.isNotEmpty()) {
				HorizontalDivider()
				Text(
					stringResource(R.string.plex_result_errors),
					style = MaterialTheme.typography.titleSmall,
					color = MaterialTheme.colorScheme.error,
				)
				r.errors.forEach { e ->
					Text("• $e", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				}
			}
		}
	}
}

@Composable
private fun CountRow(label: String, value: Long) {
	Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
		Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
		Text(value.toString(), style = MaterialTheme.typography.titleSmall)
	}
}
