package ro.mixai.tv.cast

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import ro.mixai.tv.data.HubClient
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.generated.HubDevice

/**
 * Finds music outputs that do not come from Google Cast (WP17-41h): DLNA renderers on the LAN (multicast from
 * this device), Home Assistant media players known to MMO Server, and MixAI TVs on the hub that play music.
 * Also builds the [RemoteTransport] for a picked target ([MusicOutputs.transports]).
 */
class OutputDiscovery(context: Context, private val dlna: DlnaClient) {
    private val app = context.applicationContext
    private val json = Json { ignoreUnknownKeys = true }
    private val renderers = HashMap<String, DlnaRenderer>()

    /** DLNA renderers (cached by udn so a later pick needs no new search). */
    suspend fun dlna(): List<OutputTarget.Dlna> {
        val found = dlna.discover(app)
        synchronized(renderers) { found.forEach { renderers[it.udn] = it } }
        return found.map { OutputTarget.Dlna(it) }
    }

    /** Home Assistant players (`ha:` ids) from `GET /cast/devices`; empty when HA is not configured. */
    suspend fun homeAssistant(api: MmoApi): List<OutputTarget.HomeAssistant> = try {
        parseHaDevices(json, api.getJson("/cast/devices"))
    } catch (e: CancellationException) { throw e } catch (e: Exception) { emptyList() }

    /** Everything except Cast, discovered in parallel. */
    suspend fun all(api: MmoApi?, hub: HubClient?, myDeviceId: String?): List<OutputTarget> = coroutineScope {
        val d = async { runCatching { dlna() }.getOrDefault(emptyList()) }
        val h = async { api?.let { homeAssistant(it) }.orEmpty() }
        hubTvs(hub?.devices?.value.orEmpty(), myDeviceId) + d.await() + h.await()
    }

    fun transport(target: OutputTarget, api: MmoApi?, hub: HubClient?): RemoteTransport? = when (target) {
        is OutputTarget.Dlna -> DlnaOutputTransport(dlna, target.renderer)
        is OutputTarget.HomeAssistant -> api?.let { HomeAssistantTransport(it, target.deviceId, target.name) }
        is OutputTarget.HubTv -> hub?.let { HubTvTransport(it, target.deviceId, target.name) }
        else -> null
    }

    /** Rebuilds a remembered target ([OutputMemory]) when it is still around. */
    fun restore(entry: OutputMemory.Entry, hub: HubClient?): OutputTarget? = when (entry.kind) {
        "dlna" -> synchronized(renderers) { renderers[entry.id.removePrefix("dlna:")] }?.let { OutputTarget.Dlna(it) }
        "ha" -> OutputTarget.HomeAssistant(entry.id, entry.name)
        "hub" -> entry.id.removePrefix("hub:").takeIf { id -> hub?.devices?.value?.any { it.deviceId == id } == true }
            ?.let { OutputTarget.HubTv(it, entry.name) }
        else -> null
    }

    companion object {
        /** TVs on the hub that accept a music queue (`music` cap), not this device, not guests. */
        fun hubTvs(devices: List<HubDevice>, myDeviceId: String?): List<OutputTarget.HubTv> =
            devices.filter { it.deviceId != myDeviceId && !it.guest && "music" in it.caps }
                .distinctBy { it.deviceId }
                .map { OutputTarget.HubTv(it.deviceId, it.name.ifBlank { it.platform }) }

        fun parseHaDevices(json: Json, body: String): List<OutputTarget.HomeAssistant> {
            val root = json.parseToJsonElement(body).jsonObject
            val list = root["devices"]?.jsonArray ?: return emptyList()
            return list.mapNotNull { el ->
                val o = el as? JsonObject ?: return@mapNotNull null
                val id = (o["id"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
                if (!id.startsWith("ha:")) return@mapNotNull null
                OutputTarget.HomeAssistant(id, (o["name"] as? JsonPrimitive)?.contentOrNull ?: id)
            }
        }
    }
}
