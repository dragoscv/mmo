package ro.mixai.tv.cast

import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import ro.mixai.tv.data.HubClient
import ro.mixai.tv.data.MmoApi

/** DLNA/UPnP MediaRenderer on the LAN, driven from the phone (no server involved). */
class DlnaOutputTransport(private val client: DlnaClient, private val renderer: DlnaRenderer) : RemoteTransport {
    override val target = OutputTarget.Dlna(renderer)
    override val supportsVolume get() = renderer.renderingControlUrl != null
    private var nextSupported = true
    override val supportsNext get() = nextSupported

    override suspend fun prepare(): Set<String> {
        // Reachability check (throws when the renderer is gone) + what it can decode.
        client.transport(renderer)
        return client.sinkMimes(renderer)
    }

    private fun meta(i: RemoteItem) = DlnaMeta(i.title, i.artist, i.album, i.artUrl, i.mime, i.durationMs)

    override suspend fun load(queue: List<RemoteItem>, index: Int, positionMs: Long, play: Boolean, repeat: Int) {
        val item = queue.getOrNull(index) ?: return
        // Some renderers reject SetAVTransportURI while PLAYING; a Stop first is harmless.
        runCatching { client.stop(renderer) }
        client.setUri(renderer, item.url, meta(item))
        if (play || positionMs > 2_000) client.play(renderer)
        if (positionMs > 2_000) {
            // Seek works only once the renderer actually started (TRANSITIONING rejects or ignores it).
            for (i in 0 until 20) {
                kotlinx.coroutines.delay(400)
                if (runCatching { client.transport(renderer).state }.getOrNull().equals("PLAYING", ignoreCase = true)) break
            }
            runCatching { client.seek(renderer, positionMs) }
        }
        if (!play && positionMs > 2_000) runCatching { client.pause(renderer) }
    }

    override suspend fun setNext(item: RemoteItem?): Boolean {
        if (!nextSupported || item == null) return false
        val ok = runCatching { client.setNextUri(renderer, item.url, meta(item)) }.getOrDefault(false)
        if (!ok) nextSupported = false
        return ok
    }

    override suspend fun play() = client.play(renderer)
    override suspend fun pause() = client.pause(renderer)
    override suspend fun stop() = client.stop(renderer)
    override suspend fun seek(positionMs: Long) = client.seek(renderer, positionMs)

    override suspend fun status(): RemoteStatus {
        val t = client.transport(renderer)
        val p = client.position(renderer)
        val vol = if (supportsVolume) runCatching { client.volume(renderer) }.getOrNull() else null
        return RemoteStatus(
            state = when (t.state.uppercase()) {
                "PLAYING" -> RemoteState.PLAYING
                "PAUSED_PLAYBACK", "PAUSED_RECORDING" -> RemoteState.PAUSED
                "TRANSITIONING" -> RemoteState.BUFFERING
                else -> RemoteState.STOPPED
            },
            positionMs = p.relTimeMs,
            durationMs = p.durationMs,
            uri = p.trackUri,
            volume = vol,
            error = t.status?.takeIf { it.equals("ERROR_OCCURRED", ignoreCase = true) },
        )
    }

    override suspend fun setVolume(level: Int) = client.setVolume(renderer, level)
    override suspend fun setMuted(muted: Boolean) = client.setMute(renderer, muted)
}

/** Home Assistant media player behind the MMO Server cast API (the server talks to HA). */
class HomeAssistantTransport(private val api: MmoApi, private val deviceId: String, name: String) : RemoteTransport {
    override val target = OutputTarget.HomeAssistant(deviceId, name)
    override val supportsVolume = true
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun prepare(): Set<String> {
        status()
        return emptySet()
    }

    override suspend fun load(queue: List<RemoteItem>, index: Int, positionMs: Long, play: Boolean, repeat: Int) {
        val item = queue.getOrNull(index) ?: return
        api.postJson("/cast/play", buildJsonObject {
            put("deviceId", deviceId)
            put("url", item.url)
            put("mime", item.mime)
            put("title", listOfNotNull(item.title, item.artist).joinToString(" — ").take(300))
            item.artUrl?.let { put("thumb", it) }
            if (positionMs > 2_000) put("startSec", positionMs / 1000.0)
        }.toString())
        if (!play) runCatching { command("pause") }
    }

    private suspend fun command(action: String, value: JsonPrimitive? = null) {
        api.postJson("/cast/command", buildJsonObject {
            put("deviceId", deviceId); put("action", action)
            value?.let { put("value", it) }
        }.toString())
    }

    override suspend fun play() = command("play")
    override suspend fun pause() = command("pause")
    override suspend fun stop() = command("stop")
    override suspend fun seek(positionMs: Long) = command("seek", JsonPrimitive(positionMs / 1000.0))
    override suspend fun setVolume(level: Int) = command("volume_set", JsonPrimitive(level.coerceIn(0, 100) / 100.0))
    override suspend fun setMuted(muted: Boolean) = command("volume_mute", JsonPrimitive(muted))

    override suspend fun status(): RemoteStatus {
        val o = json.parseToJsonElement(api.getJson("/cast/status/" + api.encode(deviceId))).jsonObject
        val state = o.str("state")?.lowercase()
        return RemoteStatus(
            state = when (state) {
                "playing" -> RemoteState.PLAYING
                "paused" -> RemoteState.PAUSED
                "buffering" -> RemoteState.BUFFERING
                else -> RemoteState.STOPPED
            },
            positionMs = o.num("positionSec")?.let { (it * 1000).toLong() },
            durationMs = o.num("durationSec")?.let { (it * 1000).toLong() },
            volume = o.num("volume")?.let { (it * 100).toInt() },
        )
    }
}

/**
 * A MixAI TV (Google TV / Tizen) on the hub with the `music` cap: it gets the whole queue as track ids and
 * plays it in its own music player (own server connection, its own crossfade / normalisation); this side is
 * a remote. State comes from the TV's hub `state` (nowPlaying.media.trackId).
 */
class HubTvTransport(private val hub: HubClient, private val deviceId: String, name: String) : RemoteTransport {
    override val target = OutputTarget.HubTv(deviceId, name)
    override val ownsQueue = true

    private suspend fun send(action: String, args: JsonObject = JsonObject(emptyMap())) {
        val seq = hub.command(deviceId, action, args)
        val ack = withTimeoutOrNull(ACK_MS) { hub.acks.filter { it.seq == seq }.first() }
            ?: throw IllegalStateException("no answer")
        if (!ack.ok) throw IllegalStateException(ack.error ?: "refused")
    }

    override suspend fun prepare(): Set<String> {
        if (hub.devices.value.none { it.deviceId == deviceId }) throw IllegalStateException("offline")
        return emptySet()
    }

    override suspend fun load(queue: List<RemoteItem>, index: Int, positionMs: Long, play: Boolean, repeat: Int) {
        if (queue.isEmpty()) return
        send("play", buildJsonObject {
            put("trackIds", JsonArray(queue.map { JsonPrimitive(it.trackId) }))
            put("index", index)
            put("positionSec", positionMs / 1000.0)
            put("repeat", when (repeat) { 1 -> "one"; 2 -> "all"; else -> "off" })
        })
        if (!play) runCatching { send("pause") }
    }

    override suspend fun play() = send("resume")
    override suspend fun pause() = send("pause")
    override suspend fun stop() = send("stop")
    override suspend fun seek(positionMs: Long) = send("seek", buildJsonObject { put("positionSec", positionMs / 1000.0) })
    override suspend fun next() = send("next")
    override suspend fun previous() = send("previous")

    override suspend fun status(): RemoteStatus {
        val d = hub.devices.value.firstOrNull { it.deviceId == deviceId } ?: throw IllegalStateException("offline")
        val np = d.nowPlaying ?: return RemoteStatus(RemoteState.STOPPED)
        val elapsed = if (np.playing && np.at > 0) (hub.serverNowMs() - np.at).toLong().coerceIn(0, 10_000) else 0L
        return RemoteStatus(
            state = if (np.playing) RemoteState.PLAYING else RemoteState.PAUSED,
            positionMs = (np.positionSec * 1000).toLong() + elapsed,
            durationMs = np.durationSec?.let { (it * 1000).toLong() },
            trackId = np.media?.trackId,
        )
    }

    private companion object { const val ACK_MS = 6_000L }
}

private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.contentOrNull
private fun JsonObject.num(k: String): Double? = (this[k] as? JsonPrimitive)?.doubleOrNull
@Suppress("unused") private fun JsonObject.bool(k: String): Boolean? = (this[k] as? JsonPrimitive)?.booleanOrNull
