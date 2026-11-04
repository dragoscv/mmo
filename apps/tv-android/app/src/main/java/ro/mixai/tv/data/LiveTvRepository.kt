package ro.mixai.tv.data

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import ro.mixai.tv.data.generated.LiveTvChannel
import ro.mixai.tv.data.generated.LiveTvRecording
import ro.mixai.tv.data.generated.LiveTvSource

// Live TV / DVR (`/livetv/*`, WP16-12..15). NOTE on auth: server.ts mounts `/livetv` behind
// `authMiddleware`, which reads ONLY the `x-device-token` header — `?t=` is not accepted there.
// So the player must send [streamHeaders] (Media3: `DefaultHttpDataSource.Factory()
// .setDefaultRequestProperties(liveTv.streamHeaders())`). Always use `proxy=1`: without it the
// server answers 302 to the upstream IPTV URL and the device token header would follow the redirect.
class LiveTvRepository(private val api: MmoApi, private val profileId: () -> String = { "default" }) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true; explicitNulls = false }
    private val profile: String get() = profileId().ifBlank { "default" }

    private inline fun <reified T> list(raw: String, key: String, ser: kotlinx.serialization.KSerializer<T>): List<T> {
        val arr: JsonElement = json.parseToJsonElement(raw).jsonObject[key] ?: JsonArray(emptyList())
        return json.decodeFromJsonElement(ListSerializer(ser), arr.jsonArray)
    }

    // ─── channels + guide ─────────────────────────────────────────────────

    suspend fun channels(group: String? = null, favouritesOnly: Boolean = false, includeHidden: Boolean = false, sourceId: String? = null): List<LiveTvChannel> {
        val qs = buildString {
            append("/livetv/channels?profile=").append(api.encode(profile))
            if (!group.isNullOrBlank()) append("&group=").append(api.encode(group))
            if (favouritesOnly) append("&favourites=1")
            if (includeHidden) append("&hidden=1")
            if (!sourceId.isNullOrBlank()) append("&source=").append(api.encode(sourceId))
        }
        return list(api.getJson(qs), "channels", LiveTvChannel.serializer())
    }

    suspend fun groups(): List<LiveTvGroup> = list(api.getJson("/livetv/groups"), "groups", LiveTvGroup.serializer())

    /** EPG window in epoch ms (server default now-1 h → +12 h, max 48 h). */
    suspend fun guide(fromMs: Long? = null, toMs: Long? = null, channelIds: List<String> = emptyList()): LiveTvGuide {
        val p = buildList {
            fromMs?.let { add("from=$it") }
            toMs?.let { add("to=$it") }
            if (channelIds.isNotEmpty()) add("channels=" + api.encode(channelIds.joinToString(",")))
        }
        return json.decodeFromString(api.getJson("/livetv/guide" + if (p.isEmpty()) "" else "?" + p.joinToString("&")))
    }

    suspend fun nowNext(channelIds: List<String> = emptyList()): List<LiveTvNowNext> {
        val qs = if (channelIds.isEmpty()) "" else "?channels=" + api.encode(channelIds.joinToString(","))
        return list(api.getJson("/livetv/now$qs"), "channels", LiveTvNowNext.serializer())
    }

    suspend fun setFavourite(channelId: String, favourite: Boolean) {
        val path = "/livetv/channels/${api.encode(channelId)}/favourite?profile=${api.encode(profile)}"
        if (favourite) api.putJson(path, "{}") else api.deleteJson(path)
    }

    /** Hide / reorder / renumber (fields left null are not sent). */
    suspend fun updateChannel(channelId: String, hidden: Boolean? = null, sort: Long? = null, number: String? = null): LiveTvChannel {
        val parts = buildList {
            hidden?.let { add("\"hidden\":$it") }
            sort?.let { add("\"sort\":$it") }
            number?.let { add("\"number\":" + json.encodeToString(kotlinx.serialization.serializer<String>(), it)) }
        }
        return json.decodeFromString(api.patchJson("/livetv/channels/${api.encode(channelId)}", "{" + parts.joinToString(",") + "}"))
    }

    // ─── playback URLs ────────────────────────────────────────────────────

    /** Proxied live stream (bytes piped, never transcoded). Needs [streamHeaders]. */
    fun streamUrl(channelId: String): String = "${api.baseUrl}/livetv/stream/${api.encode(channelId)}?proxy=1"

    /** Catch-up for a past programme: `startMs` epoch ms, `durationMin` 1..1440. Needs [streamHeaders]. */
    fun catchupUrl(channelId: String, startMs: Long, durationMin: Int): String =
        "${api.baseUrl}/livetv/catchup/${api.encode(channelId)}?start=$startMs&duration=$durationMin"

    // Request headers for Media3 on livetv stream/catch-up URLs.
    fun streamHeaders(): Map<String, String> = api.authHeaders()

    // ─── DVR ──────────────────────────────────────────────────────────────

    suspend fun recordings(): List<LiveTvRecording> = list(api.getJson("/livetv/recordings"), "recordings", LiveTvRecording.serializer())

    /** Record a guide programme (by its start, epoch ms). */
    suspend fun recordProgramme(channelId: String, programmeStartMs: Long, paddingBeforeSec: Long? = null, paddingAfterSec: Long? = null): LiveTvRecording {
        val body = buildString {
            append("{\"channelId\":").append(jsonStr(channelId)).append(",\"programme\":{\"start\":").append(programmeStartMs).append('}')
            paddingBeforeSec?.let { append(",\"paddingBeforeSec\":").append(it) }
            paddingAfterSec?.let { append(",\"paddingAfterSec\":").append(it) }
            append('}')
        }
        return json.decodeFromString(api.postJson("/livetv/recordings", body))
    }

    /** Record a manual time range (epoch ms). */
    suspend fun recordRange(channelId: String, startMs: Long, stopMs: Long, title: String?): LiveTvRecording {
        val body = buildString {
            append("{\"channelId\":").append(jsonStr(channelId)).append(",\"start\":").append(startMs).append(",\"stop\":").append(stopMs)
            if (!title.isNullOrBlank()) append(",\"title\":").append(jsonStr(title))
            append('}')
        }
        return json.decodeFromString(api.postJson("/livetv/recordings", body))
    }

    suspend fun deleteRecording(id: String) { api.deleteJson("/livetv/recordings/${api.encode(id)}") }

    suspend fun rules(): List<LiveTvRule> = list(api.getJson("/livetv/rules"), "rules", LiveTvRule.serializer())

    suspend fun createRule(titleMatch: String, channelId: String? = null, keepLast: Long? = null): LiveTvRule {
        val body = buildString {
            append("{\"titleMatch\":").append(jsonStr(titleMatch))
            if (channelId != null) append(",\"channelId\":").append(jsonStr(channelId))
            keepLast?.let { append(",\"keepLast\":").append(it) }
            append('}')
        }
        return json.decodeFromString(api.postJson("/livetv/rules", body))
    }

    suspend fun deleteRule(id: String) { api.deleteJson("/livetv/rules/${api.encode(id)}") }

    // ─── sources (M3U / Xtream / HDHomeRun) ───────────────────────────────

    suspend fun sources(): List<LiveTvSource> = list(api.getJson("/livetv/sources"), "sources", LiveTvSource.serializer())

    suspend fun createSource(input: LiveTvSourceInput): LiveTvSource =
        json.decodeFromString(api.postJson("/livetv/sources", json.encodeToString(LiveTvSourceInput.serializer(), input)))

    suspend fun updateSource(id: String, input: LiveTvSourceInput): LiveTvSource =
        json.decodeFromString(api.patchJson("/livetv/sources/${api.encode(id)}", json.encodeToString(LiveTvSourceInput.serializer(), input)))

    suspend fun deleteSource(id: String) { api.deleteJson("/livetv/sources/${api.encode(id)}") }

    suspend fun testSource(id: String): LiveTvSourceTest = json.decodeFromString(api.postJson("/livetv/sources/${api.encode(id)}/test", "{}"))

    suspend fun refreshSource(id: String) { api.postJson("/livetv/sources/${api.encode(id)}/refresh", "{}") }

    private fun jsonStr(s: String) = json.encodeToString(kotlinx.serialization.serializer<String>(), s)
}
