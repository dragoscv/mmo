package ro.mixai.app.ui.title

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import ro.mixai.app.R
import ro.mixai.app.ui.media.PlayTarget
import ro.mixai.tv.data.MmoApi

// Title-page labels and small helpers shared with Home (play label, age chip, logo, trailer, toast).

/** "Play" / "Play S1 E1" / "Resume S2 E4 · 12 min left" / "Resume · 12 min left". */
@Composable
fun playLabel(t: PlayTarget?): String {
    if (t == null) return stringResource(R.string.title_play)
    val s = (t.ref.season ?: 0L).toInt()
    val e = (t.ref.episode ?: 0L).toInt()
    val ep = s > 0 && e > 0
    val left = t.leftMin?.toInt()
    return when {
        t.resumeMs > 0 && ep && left != null -> stringResource(R.string.title_resume_ep_left, s, e, left)
        t.resumeMs > 0 && ep -> stringResource(R.string.title_resume_ep, s, e)
        t.resumeMs > 0 && left != null -> stringResource(R.string.title_resume_left, left)
        t.resumeMs > 0 -> stringResource(R.string.title_resume)
        ep -> stringResource(R.string.title_play_ep, s, e)
        else -> stringResource(R.string.title_play)
    }
}

/** Age chip: `12+`, all ages; falls back to the raw certification. */
@Composable
fun ageLabel(age: Long?, certification: String? = null): String? = when {
    age != null && age <= 0L -> stringResource(R.string.title_age_all)
    age != null -> "$age+"
    certification.isNullOrBlank() -> null
    certification.all { it.isDigit() } -> if (certification == "0") stringResource(R.string.title_age_all) else "$certification+"
    else -> certification
}

@Composable
fun runtimeLabel(min: Long?): String? {
    if (min == null || min <= 0L) return null
    val h = (min / 60).toInt()
    val m = (min % 60).toInt()
    return if (h > 0) stringResource(R.string.title_runtime_hm, h, m) else stringResource(R.string.title_runtime_m, m)
}

/** TMDB logo (w500) or the title as display text. `color` applies to the text fallback. */
@Composable
fun TitleLogo(
    api: MmoApi,
    logoPath: String?,
    title: String,
    modifier: Modifier = Modifier,
    height: Dp = 88.dp,
    maxWidth: Dp = 320.dp,
    color: Color = Color.Unspecified,
) {
    val logo = api.tmdbImageUrl("w500", logoPath)
    Box(modifier.widthIn(max = maxWidth), contentAlignment = Alignment.BottomStart) {
        if (logo != null) {
            AsyncImage(
                model = logo,
                contentDescription = title,
                contentScale = ContentScale.Fit,
                alignment = Alignment.BottomStart,
                modifier = Modifier.height(height).widthIn(max = maxWidth),
            )
        } else {
            Text(title, style = MaterialTheme.typography.displaySmall, color = color, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

fun toast(context: Context, text: String) = Toast.makeText(context, text, Toast.LENGTH_SHORT).show()

/** Opens the trailer in the YouTube app, falling back to any handler (browser). */
fun launchTrailer(context: Context, key: String) {
    val uri = Uri.parse("https://www.youtube.com/watch?v=$key")
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri).setPackage("com.google.android.youtube"))
    } catch (_: ActivityNotFoundException) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            toast(context, context.getString(R.string.title_trailer_failed))
        }
    }
}

/** Season numbers ascending with specials (0) last; specials dropped when real seasons exist. */
fun orderedSeasons(nums: List<Long>): List<Long> {
    val sorted = nums.distinct().sorted()
    val real = sorted.filter { it != 0L }
    return real.ifEmpty { sorted }
}
