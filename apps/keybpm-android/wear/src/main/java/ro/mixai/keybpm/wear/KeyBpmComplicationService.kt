package ro.mixai.keybpm.wear

import android.app.PendingIntent
import android.content.Intent
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import ro.mixai.listen.Harmony

/** Complication (WP18-04): SHORT_TEXT = Camelot key + BPM title, RANGED_VALUE = BPM on a 60..200 arc. Push-only. */
class KeyBpmComplicationService : SuspendingComplicationDataSourceService() {
    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? =
        build(request.complicationType, LastReading.get(this).keyIndex, LastReading.get(this).bpm)

    override fun getPreviewData(type: ComplicationType): ComplicationData? = build(type, 21, 124.0)

    private fun build(type: ComplicationType, key: Int?, bpm: Double?): ComplicationData? {
        val keyText = key?.let { Harmony.camelot(it) } ?: "—"
        val bpmText = bpm?.let { "%.0f".format(it) } ?: "—"
        val desc = PlainComplicationText.Builder(getString(R.string.cd_complication, keyText, bpmText)).build()
        val tap = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return when (type) {
            ComplicationType.SHORT_TEXT -> ShortTextComplicationData.Builder(PlainComplicationText.Builder(keyText).build(), desc)
                .setTitle(PlainComplicationText.Builder(bpmText).build())
                .setTapAction(tap)
                .build()
            ComplicationType.RANGED_VALUE -> RangedValueComplicationData.Builder(
                value = (bpm ?: 60.0).toFloat().coerceIn(60f, 200f), min = 60f, max = 200f, contentDescription = desc,
            )
                .setText(PlainComplicationText.Builder(keyText).build())
                .setTitle(PlainComplicationText.Builder(bpmText).build())
                .setTapAction(tap)
                .build()
            else -> null
        }
    }
}
