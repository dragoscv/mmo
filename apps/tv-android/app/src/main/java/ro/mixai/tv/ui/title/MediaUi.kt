package ro.mixai.tv.ui.title

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import ro.mixai.tv.R
import ro.mixai.tv.data.ApiException
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.ProviderLauncher
import ro.mixai.tv.data.androidPackage
import ro.mixai.tv.data.generated.MediaTitleResponse
import ro.mixai.tv.data.generated.Offer
import ro.mixai.tv.data.generated.Person
import ro.mixai.tv.data.generated.ProgressEntry
import ro.mixai.tv.data.generated.TitleDetails
import ro.mixai.tv.data.generated.VersionedFile
import ro.mixai.tv.player.PlayRequest
import ro.mixai.tv.ui.components.EmptyState
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens
import kotlin.math.roundToLong

// Shared helpers for Home, Title, Season and Library (WP16-18/19/20): play-target resolution,
// labels (play/resume, age, formats), trailer launch, provider offers, cast and pills.

/** What the primary button plays: one server file, its TMDB identity and where to start. */
data class PlayTarget(
    val fileId: String,
    val ref: MediaRef,
    /** Absolute start (ms); -1 = let the player use the local resume position. */
    val resumeMs: Long,
    /** Minutes left when resuming (null when unknown). */
    val leftMin: Long?,
)

fun VersionedFile.isEpisode(): Boolean = (season ?: 0L) > 0L || (episode ?: 0L) > 0L

/** Preferred file when still present, else the best version (`version.rank`). */
fun bestFile(files: List<VersionedFile>, preferredId: String? = null): VersionedFile? =
    files.firstOrNull { it.serverFileId == preferredId } ?: files.maxByOrNull { it.version.rank }

private fun resumeOf(p: ProgressEntry?): Pair<Long, Long?> {
    if (p == null || p.completed || p.positionSec <= 0.0) return -1L to null
    val left = if (p.durationSec > p.positionSec) ((p.durationSec - p.positionSec) / 60.0).roundToLong().coerceAtLeast(1L) else null
    return (p.positionSec * 1000).toLong() to left
}

/** Target for one episode's files (null when none are on the server). */
fun episodeTarget(tmdbId: Long, season: Long, episode: Long, files: List<VersionedFile>, progress: ProgressEntry?, preferredId: String? = null): PlayTarget? {
    val f = bestFile(files, preferredId) ?: return null
    val (ms, left) = resumeOf(progress)
    return PlayTarget(f.serverFileId, MediaRef("tv", tmdbId, season, episode), ms, left)
}

/** Movie target: best (or preferred) movie file + its resume position. */
fun movieTarget(d: MediaTitleResponse, preferredId: String? = null): PlayTarget? {
    val f = bestFile(d.files.filter { !it.isEpisode() }.ifEmpty { d.files }, preferredId) ?: return null
    val (ms, left) = resumeOf(d.progress.firstOrNull { it.season == 0L && it.episode == 0L })
    return PlayTarget(f.serverFileId, MediaRef(d.title.kind.ifBlank { "movie" }, d.title.tmdbId), ms, left)
}

/**
 * Primary play target of a title. Movies → [movieTarget]. Series → `nextUp` episode (title files,
 * else the season endpoint), else the earliest local episode not completed.
 */
suspend fun resolveTarget(deps: ScreenDeps, d: MediaTitleResponse, preferredId: String? = null): PlayTarget? {
    if (d.title.kind != "tv") return movieTarget(d, preferredId)
    val id = d.title.tmdbId
    val eps = d.files.filter { it.isEpisode() }
    val nu = d.nextUp
    if (nu != null && nu.season > 0) {
        var files = eps.filter { it.season == nu.season && it.episode == nu.episode }
        if (files.isEmpty()) {
            files = runCatching { deps.media.season(id, nu.season).episodes.firstOrNull { it.episodeNumber == nu.episode }?.files }.getOrNull().orEmpty()
        }
        if (files.isNotEmpty()) {
            val p = d.progress.firstOrNull { it.season == nu.season && it.episode == nu.episode }
            val t = episodeTarget(id, nu.season, nu.episode, files, p, preferredId)
            if (t != null && t.resumeMs < 0 && nu.positionSec > 0) return t.copy(resumeMs = (nu.positionSec * 1000).toLong())
            return t
        }
    }
    if (eps.isEmpty()) return null
    val done = d.progress.filter { it.completed }.map { it.season to it.episode }.toSet()
    val order = compareBy<VersionedFile>({ it.season ?: 0L }, { it.episode ?: 0L })
    val pick = eps.filter { ((it.season ?: 0L) to (it.episode ?: 0L)) !in done }.minWithOrNull(order) ?: eps.minWithOrNull(order) ?: return null
    val s = pick.season ?: 0L
    val e = pick.episode ?: 0L
    return episodeTarget(id, s, e, eps.filter { it.season == pick.season && it.episode == pick.episode }, d.progress.firstOrNull { it.season == s && it.episode == e })
}

/** Resolves the file (`/video/file/{id}/info`) and pushes the player. Same hls rule as the old screens. */
suspend fun startPlayback(deps: ScreenDeps, nav: Navigator, t: PlayTarget, fromStart: Boolean = false) {
    val f = deps.api.fileInfo(t.fileId)
    nav.push(
        Route.Play(
            PlayRequest.Video(f, hls = !f.directPlayable, fromStart = fromStart, ref = t.ref),
            resumeMs = if (fromStart) 0L else t.resumeMs,
            from = nav.current,
        ),
    )
}

/** "Play" / "Play S1 E1" / "Resume S2 E4 · 12 min left" / "Resume · 12 min left". */
@Composable
fun playLabel(t: PlayTarget?): String {
    if (t == null) return stringResource(R.string.wp16_title_play)
    val s = t.ref.season ?: 0L
    val e = t.ref.episode ?: 0L
    val ep = s > 0L && e > 0L
    val left = t.leftMin
    return when {
        t.resumeMs > 0 && ep && left != null -> stringResource(R.string.wp16_title_resume_ep_left, s, e, left)
        t.resumeMs > 0 && ep -> stringResource(R.string.wp16_title_resume_ep, s, e)
        t.resumeMs > 0 && left != null -> stringResource(R.string.wp16_title_resume_left, left)
        t.resumeMs > 0 -> stringResource(R.string.wp16_title_resume)
        ep -> stringResource(R.string.wp16_title_play_ep, s, e)
        else -> stringResource(R.string.wp16_title_play)
    }
}

/** Age chip: `12+`, `AG` (all ages); falls back to the raw certification. */
@Composable
fun ageLabel(age: Long?, certification: String? = null): String? = when {
    age != null && age <= 0L -> stringResource(R.string.wp16_age_all)
    age != null -> "$age+"
    certification.isNullOrBlank() -> null
    certification.all { it.isDigit() } -> if (certification == "0") stringResource(R.string.wp16_age_all) else "$certification+"
    else -> certification
}

/** Technical format chips from the local versions (never localised: 4K, HD, DV, HDR). */
fun formatChips(files: List<VersionedFile>): List<String> = buildList {
    if (files.any { it.version.resolution == "2160p" }) add("4K") else if (files.any { it.version.resolution == "1080p" }) add("HD")
    if (files.any { it.version.hdr == "DV" }) add("DV")
    if (files.any { it.version.hdr == "HDR" || it.version.hdr == "HDR10+" }) add("HDR")
}

fun yearOf(date: String?): String? = date?.take(4)?.takeIf { it.length == 4 && it.all(Char::isDigit) }

fun genresOf(t: TitleDetails): List<String> = t.genres.mapNotNull { it.str("name") }

private fun JsonObject.str(key: String): String? = runCatching { this[key]?.jsonPrimitive?.contentOrNull }.getOrNull()?.takeIf { it.isNotBlank() }

/** YouTube key of the best trailer (official Trailer first, then any YouTube video). */
fun trailerKey(t: TitleDetails): String? {
    val yt = t.videos.filter { it.str("site").equals("YouTube", ignoreCase = true) && it.str("key") != null }
    return (yt.firstOrNull { it.str("type") == "Trailer" } ?: yt.firstOrNull())?.str("key")
}

/** Opens the trailer in YouTube for Android TV, falling back to any handler (browser). */
fun launchTrailer(context: Context, key: String) {
    val uri = Uri.parse("https://www.youtube.com/watch?v=$key")
    val pinned = Intent(Intent.ACTION_VIEW, uri).setPackage("com.google.android.youtube.tv").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(pinned)
    } catch (_: ActivityNotFoundException) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(context, context.getString(R.string.wp16_title_trailer_failed), Toast.LENGTH_SHORT).show()
        }
    }
}

fun toast(context: Context, text: String) = Toast.makeText(context, text, Toast.LENGTH_SHORT).show()

/** Logo (TMDB `logoPath`, w500) or the title as display text. */
@Composable
fun TitleLogo(api: MmoApi, logoPath: String?, title: String, modifier: Modifier = Modifier, height: Dp = 110.dp, maxWidth: Dp = 520.dp) {
    val logo = api.tmdbImageUrl("w500", logoPath)
    Box(modifier.height(height).widthIn(max = maxWidth), contentAlignment = Alignment.BottomStart) {
        if (logo != null) {
            AsyncImage(model = logo, contentDescription = title, contentScale = ContentScale.Fit, alignment = Alignment.BottomStart, modifier = Modifier.height(height).widthIn(max = maxWidth))
        } else {
            Text(title, style = MaterialTheme.typography.displaySmall, color = Tokens.foreground, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Error body for a title / season: kid-friendly 403, "TMDB not configured" 503, generic + Retry. */
@Composable
fun TitleError(e: Throwable, onRetry: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val status = (e as? ApiException)?.status
    when (status) {
        403 -> EmptyState(
            icon = MixaiIcons.Kids,
            title = stringResource(R.string.wp16_title_age_title),
            message = stringResource(R.string.wp16_title_age_message),
            modifier = modifier,
            action = { m -> SecondaryButton(stringResource(R.string.wp16_title_back), onBack, m) },
        )
        503 -> ErrorState(stringResource(R.string.wp16_title_tmdb_missing), onRetry, modifier, title = stringResource(R.string.wp16_title_error))
        else -> ErrorState(e.message ?: e.javaClass.simpleName, onRetry, modifier, title = stringResource(R.string.wp16_title_error))
    }
}

/** Focusable pill (season tabs, letter strip, filters). */
@Composable
fun TvPill(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, onLongClick: (() -> Unit)? = null) {
    Surface(
        onClick = onClick,
        onLongClick = onLongClick,
        modifier = modifier,
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(50)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = if (selected) Tokens.foreground.copy(alpha = 0.22f) else Tokens.foreground.copy(alpha = 0.06f),
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
            pressedContainerColor = Tokens.foreground,
            pressedContentColor = Tokens.background,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, maxLines = 1, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
    }
}

/** Provider button: logo (`w92`) + name + offer type; dimmed with "Install" when the app is missing. */
@Composable
fun OfferButton(api: MmoApi, offer: Offer, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val pkg = offer.launch.androidPackage
    val installed = remember(pkg) { pkg == null || ProviderLauncher.isInstalled(context, pkg) }
    val type = stringResource(
        when (offer.type) {
            "rent" -> R.string.wp16_title_offer_rent
            "buy" -> R.string.wp16_title_offer_buy
            "free" -> R.string.wp16_title_offer_free
            "ads" -> R.string.wp16_title_offer_ads
            else -> R.string.wp16_title_offer_subscription
        },
    )
    Surface(
        onClick = { ProviderLauncher.launch(context, offer) },
        modifier = modifier.alpha(if (installed) 1f else 0.6f),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(12.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Tokens.foreground.copy(alpha = 0.08f),
            contentColor = Tokens.foreground,
            focusedContainerColor = Tokens.foreground,
            focusedContentColor = Tokens.background,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.05f),
        glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(MixaiFocus.glowColor, 12.dp)),
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            val logo = api.tmdbImageUrl("w92", offer.logo)
            if (logo != null) {
                AsyncImage(model = logo, contentDescription = null, modifier = Modifier.size(36.dp).clip(RoundedCornerShape(8.dp)))
                Spacer(Modifier.width(12.dp))
            }
            Column {
                Text(offer.name, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                Text(if (installed) type else stringResource(R.string.wp16_title_offer_install), style = MaterialTheme.typography.labelSmall, maxLines = 1)
            }
        }
    }
}

/** Round cast avatar (w185) + name + role. */
@Composable
fun CastItem(api: MmoApi, person: Person, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.width(128.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Surface(
            onClick = onClick,
            modifier = Modifier.size(104.dp),
            shape = ClickableSurfaceDefaults.shape(CircleShape),
            colors = ClickableSurfaceDefaults.colors(containerColor = Tokens.card, focusedContainerColor = Tokens.card),
            border = ClickableSurfaceDefaults.border(
                focusedBorder = androidx.tv.material3.Border(androidx.compose.foundation.BorderStroke(MixaiFocus.ringWidth, Tokens.ring), shape = CircleShape),
            ),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1.08f),
        ) {
            val img = api.tmdbImageUrl("w185", person.profilePath)
            if (img != null) {
                AsyncImage(model = img, contentDescription = person.name, contentScale = ContentScale.Crop, modifier = Modifier.size(104.dp).clip(CircleShape))
            } else {
                Box(Modifier.size(104.dp).background(Tokens.accent), contentAlignment = Alignment.Center) {
                    Text(person.name.take(1), style = MaterialTheme.typography.headlineSmall, color = Tokens.accentForeground)
                }
            }
        }
        Text(person.name, style = MaterialTheme.typography.labelLarge, color = Tokens.foreground, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        if (person.role.isNotBlank()) {
            Text(person.role, style = MaterialTheme.typography.labelSmall, color = Tokens.mutedForeground, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        }
    }
}
