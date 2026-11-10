package ro.mixai.live.wear

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.TimelineBuilders.Timeline
import androidx.wear.protolayout.material3.MaterialScope
import androidx.wear.protolayout.material3.Typography
import androidx.wear.protolayout.material3.buttonGroup
import androidx.wear.protolayout.material3.primaryLayout
import androidx.wear.protolayout.material3.text
import androidx.wear.protolayout.material3.textButton
import androidx.wear.protolayout.material3.textEdgeButton
import androidx.wear.protolayout.types.layoutString
import androidx.wear.tiles.Material3TileService
import androidx.wear.tiles.RequestBuilders.TileRequest
import androidx.wear.tiles.TileBuilders.Tile
import androidx.wear.tiles.tile
import ro.mixai.live.core.ClientMsg

/**
 * Tile: current part + previous / next scene + MUTE edge button. Button clicks come back as tile requests with the
 * clicked id (LoadAction); the service forwards them through the app's client (connecting first if needed).
 */
class LiveTileService : Material3TileService() {
    override suspend fun MaterialScope.tileResponse(requestParams: TileRequest): Tile {
        val ctx = this@LiveTileService
        val app = ctx.application as LiveWearApp
        when (requestParams.currentState.lastClickableId) {
            ID_PREV -> app.sendWhenReady(ClientMsg.Prev)
            ID_NEXT -> app.sendWhenReady(ClientMsg.Next)
            ID_MUTE -> app.sendWhenReady(ClientMsg.SetMix(mute = !LastGlance.get(ctx).muted))
        }
        val g = LastGlance.get(ctx)
        val title = if (g.connected) g.part ?: g.song ?: ctx.getString(R.string.app_short) else ctx.getString(R.string.tile_empty)
        fun click(id: String) = ModifiersBuilders.Clickable.Builder()
            .setId(id)
            .setOnClick(ActionBuilders.LoadAction.Builder().build())
            .build()
        return tile(
            timeline = Timeline.fromLayoutElement(
                primaryLayout(
                    titleSlot = { text(ctx.getString(R.string.app_short).layoutString) },
                    mainSlot = {
                        buttonGroup {
                            buttonGroupItem { textButton(onClick = click(ID_PREV), labelContent = { text("◀".layoutString) }) }
                            buttonGroupItem { text(title.layoutString, typography = Typography.TITLE_MEDIUM, maxLines = 2) }
                            buttonGroupItem { textButton(onClick = click(ID_NEXT), labelContent = { text("▶".layoutString) }) }
                        }
                    },
                    bottomSlot = {
                        textEdgeButton(
                            onClick = click(ID_MUTE),
                            labelContent = { text(ctx.getString(if (g.muted) R.string.unmute else R.string.mute).layoutString) },
                        )
                    },
                ),
            ),
        )
    }

    private companion object {
        const val ID_PREV = "prev"
        const val ID_NEXT = "next"
        const val ID_MUTE = "mute"
    }
}
