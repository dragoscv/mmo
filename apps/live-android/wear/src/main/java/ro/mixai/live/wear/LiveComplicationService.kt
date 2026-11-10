package ro.mixai.live.wear

import android.app.PendingIntent
import android.content.Intent
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.LongTextComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService

/** Complication: SHORT_TEXT = current part, LONG_TEXT = part + song. Push-only (updated by the app on change). */
class LiveComplicationService : SuspendingComplicationDataSourceService() {
    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? =
        build(request.complicationType, LastGlance.get(this))

    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        build(type, Glance(connected = true, part = "Chorus", song = "Song", muted = false))

    private fun build(type: ComplicationType, g: Glance): ComplicationData? {
        val part = if (g.connected) g.part ?: "—" else "—"
        val desc = PlainComplicationText.Builder(getString(R.string.cd_complication, part)).build()
        val tap = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return when (type) {
            ComplicationType.SHORT_TEXT -> ShortTextComplicationData.Builder(PlainComplicationText.Builder(part.take(7)).build(), desc)
                .setTitle(PlainComplicationText.Builder(getString(R.string.app_short)).build())
                .setTapAction(tap)
                .build()
            ComplicationType.LONG_TEXT -> LongTextComplicationData.Builder(PlainComplicationText.Builder(part).build(), desc)
                .apply { g.song?.takeIf { g.connected }?.let { setTitle(PlainComplicationText.Builder(it).build()) } }
                .setTapAction(tap)
                .build()
            else -> null
        }
    }
}
