package ro.mixai.keybpm.wear

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.TimelineBuilders.Timeline
import androidx.wear.protolayout.material3.MaterialScope
import androidx.wear.protolayout.material3.Typography
import androidx.wear.protolayout.material3.primaryLayout
import androidx.wear.protolayout.material3.text
import androidx.wear.protolayout.material3.textEdgeButton
import androidx.wear.protolayout.types.layoutString
import androidx.wear.tiles.Material3TileService
import androidx.wear.tiles.RequestBuilders.TileRequest
import androidx.wear.tiles.TileBuilders.Tile
import androidx.wear.tiles.tile
import androidx.wear.protolayout.LayoutElementBuilders.Column
import ro.mixai.listen.Harmony

/**
 * Tile (WP18-04): last key (Camelot + name) and BPM from the watch or the phone, "Listen" edge button opens the app
 * (which starts the microphone; a tile cannot start it from the background). Push-only updates.
 */
class KeyBpmTileService : Material3TileService() {
    override suspend fun MaterialScope.tileResponse(requestParams: TileRequest): Tile {
        val ctx = this@KeyBpmTileService
        val v = LastReading.get(ctx)
        val key = v.keyIndex?.let { "${Harmony.camelot(it)} · ${Harmony.keyName(it)}" } ?: "—"
        val bpm = v.bpm?.let { ctx.getString(R.string.bpm_value, it) } ?: ctx.getString(R.string.tile_empty)
        val open = ModifiersBuilders.Clickable.Builder()
            .setId("open")
            .setOnClick(
                ActionBuilders.LaunchAction.Builder()
                    .setAndroidActivity(
                        ActionBuilders.AndroidActivity.Builder()
                            .setPackageName(ctx.packageName)
                            .setClassName(MainActivity::class.java.name)
                            .addKeyToExtraMapping(MainActivity.EXTRA_START, ActionBuilders.AndroidBooleanExtra.Builder().setValue(true).build())
                            .build(),
                    )
                    .build(),
            )
            .build()
        return tile(
            timeline = Timeline.fromLayoutElement(
                primaryLayout(
                    titleSlot = { text(ctx.getString(R.string.app_short).layoutString) },
                    mainSlot = {
                        Column.Builder()
                            .addContent(text(key.layoutString, typography = Typography.DISPLAY_SMALL))
                            .addContent(text(bpm.layoutString, typography = Typography.TITLE_MEDIUM))
                            .build()
                    },
                    bottomSlot = {
                        textEdgeButton(onClick = open, labelContent = { text(ctx.getString(R.string.listen).layoutString) })
                    },
                ),
            ),
        )
    }
}
