package ro.mixai.live.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

// MixAI Live control protocol v1 (docs/live/remote-protocol.md). Field names are the serde forms of the Rust engine
// types (live_engine::session::SessionState etc.). Unknown fields and message types are ignored (forward compatible).

const val PROTOCOL_VERSION = 1
const val DEFAULT_PORT = 17920
const val MDNS_SERVICE = "_mixai-live._tcp."

val LiveJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
    isLenient = true
}

@Serializable
enum class Role {
    @SerialName("viewer") VIEWER,
    @SerialName("performer") PERFORMER,
    @SerialName("controller") CONTROLLER;

    fun atLeast(other: Role): Boolean = ordinal >= other.ordinal

    companion object {
        fun parse(s: String?): Role? = entries.firstOrNull { it.name.equals(s, ignoreCase = true) }
    }
}

/** Rust `Vec<(String, f32)>` = JSON `[["id", 0.5], ...]`. */
object ParamPairsSerializer : KSerializer<List<Pair<String, Float>>> {
    private val delegate = ListSerializer(JsonArray.serializer())
    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun deserialize(decoder: Decoder): List<Pair<String, Float>> {
        val el = (decoder as JsonDecoder).decodeJsonElement()
        if (el !is JsonArray) return emptyList()
        return el.mapNotNull { pair ->
            val a = pair as? JsonArray ?: return@mapNotNull null
            val id = (a.getOrNull(0) as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
            val v = (a.getOrNull(1) as? JsonPrimitive)?.floatOrNull ?: return@mapNotNull null
            id to v
        }
    }

    override fun serialize(encoder: Encoder, value: List<Pair<String, Float>>) {
        (encoder as JsonEncoder).encodeJsonElement(
            buildJsonArray { value.forEach { (k, v) -> add(buildJsonArray { add(JsonPrimitive(k)); add(JsonPrimitive(v)) }) } },
        )
    }
}

@Serializable
data class InsertState(
    val id: Int,
    val fx: String,
    val enabled: Boolean = true,
    @Serializable(with = ParamPairsSerializer::class) val params: List<Pair<String, Float>> = emptyList(),
) {
    fun param(id: String): Float? = params.firstOrNull { it.first == id }?.second
}

@Serializable
data class MixState(
    @SerialName("input_db") val inputDb: Float = 0f,
    @SerialName("main_db") val mainDb: Float = 0f,
    @SerialName("monitor_db") val monitorDb: Float = 0f,
    @SerialName("monitor_dry") val monitorDry: Float = 0f,
    val bypass: Boolean = false,
    val mute: Boolean = false,
)

@Serializable
data class Position(val song: Int = 0, val part: Int = 0)

@Serializable
data class SongPart(val name: String = "", val preset: String = "", val program: Int? = null)

@Serializable
data class Song(
    val title: String = "",
    val artist: String = "",
    val key: String? = null,
    val bpm: Float? = null,
    val parts: List<SongPart> = emptyList(),
    val lyrics: String? = null,
    val notes: String = "",
)

@Serializable
data class Setlist(val version: Int = 1, val name: String = "", val songs: List<Song> = emptyList())

@Serializable
data class SessionState(
    val preset: String = "",
    val chain: List<InsertState> = emptyList(),
    val mix: MixState = MixState(),
    val setlist: Setlist? = null,
    val position: Position? = null,
    val presets: List<String> = emptyList(),
    val bpm: Float? = null,
    val revision: Long = 0,
) {
    val currentSong: Song? get() = position?.let { p -> setlist?.songs?.getOrNull(p.song) }
    val currentPart: SongPart? get() = position?.let { p -> currentSong?.parts?.getOrNull(p.part) }
}

@Serializable
data class Hello(
    val protocol: Int = PROTOCOL_VERSION,
    val version: String = "",
    val role: Role = Role.VIEWER,
    @SerialName("engine_name") val engineName: String = "",
    @SerialName("sample_rate") val sampleRate: Int? = null,
    @SerialName("buffer_frames") val bufferFrames: Int? = null,
    val client: String? = null,
) {
    val updateRequired: Boolean get() = protocol > PROTOCOL_VERSION
}

@Serializable
data class Tune(
    val freq: Float = 0f,
    val midi: Float = 0f,
    val cents: Float = 0f,
    val target: Int? = null,
    @SerialName("correction_cents") val correctionCents: Float = 0f,
)

@Serializable
data class Meters(
    @SerialName("in_peak") val inPeak: Float = 0f,
    @SerialName("in_rms") val inRms: Float = 0f,
    @SerialName("out_peak") val outPeak: List<Float> = listOf(0f, 0f),
    @SerialName("out_rms") val outRms: List<Float> = listOf(0f, 0f),
    val gr: List<Float> = emptyList(),
    @SerialName("dsp_load") val dspLoad: Float = 0f,
    @SerialName("dsp_load_max") val dspLoadMax: Float = 0f,
    val xruns: Long = 0,
    val clipped: Boolean = false,
    val tune: Tune? = null,
    @SerialName("latency_probe") val latencyProbe: JsonElement? = null,
)

@Serializable
data class FxParamSpec(
    val id: String,
    val min: Float = 0f,
    val max: Float = 1f,
    val default: Float = 0f,
    val unit: String = "none",
    val curve: String = "linear",
    val choices: List<String> = emptyList(),
) {
    val isLog: Boolean get() = curve == "log" && min > 0f
    val isToggle: Boolean get() = unit == "toggle"
    val isChoice: Boolean get() = unit == "choice"

    fun clamp(v: Float): Float {
        if (!v.isFinite()) return default
        val c = v.coerceIn(min, max)
        return if (isToggle || isChoice) Math.round(c).toFloat() else c
    }

    /** Same mapping as `ParamSpec::from_normalized` in live-dsp. */
    fun fromNorm(n: Float): Float {
        val x = if (n.isFinite()) n.coerceIn(0f, 1f) else 0f
        val v = if (isLog) min * Math.pow((max / min).toDouble(), x.toDouble()).toFloat() else min + (max - min) * x
        return clamp(v)
    }

    /** Same mapping as `ParamSpec::to_normalized` in live-dsp. */
    fun toNorm(v: Float): Float {
        val c = clamp(v)
        if (max <= min) return 0f
        return if (isLog) (Math.log((c / min).toDouble()) / Math.log((max / min).toDouble())).toFloat() else (c - min) / (max - min)
    }
}

@Serializable
data class FxSpec(val id: String, val params: List<FxParamSpec> = emptyList())

/** Server → client messages. */
sealed interface ServerMsg {
    data class HelloMsg(val hello: Hello) : ServerMsg
    data class StateMsg(val state: SessionState) : ServerMsg
    data class MetersMsg(val meters: Meters) : ServerMsg
    data class Ack(val id: Int?) : ServerMsg
    data class Error(val id: Int?, val code: String, val message: String) : ServerMsg
    data class Pong(val t: Long?) : ServerMsg
    data class Unknown(val type: String?) : ServerMsg

    companion object {
        fun parse(text: String): ServerMsg? {
            val obj = runCatching { LiveJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return null
            val type = (obj["type"] as? JsonPrimitive)?.contentOrNull
            return runCatching {
                when (type) {
                    "hello" -> HelloMsg(LiveJson.decodeFromJsonElement(Hello.serializer(), obj))
                    "state" -> {
                        val st = obj["state"]
                        if (st == null || st is JsonNull) null else StateMsg(LiveJson.decodeFromJsonElement(SessionState.serializer(), st))
                    }
                    "meters" -> MetersMsg(LiveJson.decodeFromJsonElement(Meters.serializer(), obj))
                    "ack" -> Ack(obj.int("id"))
                    "error" -> Error(obj.int("id"), obj.str("code") ?: "unknown", obj.str("message") ?: "")
                    "pong" -> Pong((obj["t"] as? JsonPrimitive)?.longOrNull)
                    else -> Unknown(type)
                }
            }.getOrNull()
        }

        private fun JsonObject.int(k: String): Int? = (this[k] as? JsonPrimitive)?.intOrNull
        private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.contentOrNull
    }
}

/** Client → server messages; [required] mirrors `Control::required_role` on the engine. */
sealed class ClientMsg(val type: String, val required: Role) {
    protected open fun fields(b: MutableMap<String, JsonElement>) {}

    fun toJson(id: Int? = null): String = JsonObject(
        buildMap {
            put("type", JsonPrimitive(type))
            if (id != null) put("id", JsonPrimitive(id))
            fields(this)
        },
    ).toString()

    data class Subscribe(val meters: Boolean, val metersHz: Int? = null) : ClientMsg("subscribe", Role.VIEWER) {
        override fun fields(b: MutableMap<String, JsonElement>) {
            b["meters"] = JsonPrimitive(meters)
            if (metersHz != null) b["meters_hz"] = JsonPrimitive(metersHz.coerceIn(1, 30))
        }
    }

    data class Ping(val t: Long) : ClientMsg("ping", Role.VIEWER) {
        override fun fields(b: MutableMap<String, JsonElement>) { b["t"] = JsonPrimitive(t) }
    }

    data class SetParam(val insert: Int, val param: String, val value: Float) : ClientMsg("set_param", Role.CONTROLLER) {
        override fun fields(b: MutableMap<String, JsonElement>) {
            b["insert"] = JsonPrimitive(insert); b["param"] = JsonPrimitive(param); b["value"] = JsonPrimitive(value)
        }
    }

    data class SetParamNorm(val insert: Int, val param: String, val norm: Float) : ClientMsg("set_param_norm", Role.CONTROLLER) {
        override fun fields(b: MutableMap<String, JsonElement>) {
            b["insert"] = JsonPrimitive(insert); b["param"] = JsonPrimitive(param); b["norm"] = JsonPrimitive(norm.coerceIn(0f, 1f))
        }
    }

    data class SetEnabled(val insert: Int, val on: Boolean) : ClientMsg("set_enabled", Role.CONTROLLER) {
        override fun fields(b: MutableMap<String, JsonElement>) { b["insert"] = JsonPrimitive(insert); b["on"] = JsonPrimitive(on) }
    }

    data class LoadPreset(val name: String) : ClientMsg("load_preset", Role.PERFORMER) {
        override fun fields(b: MutableMap<String, JsonElement>) { b["name"] = JsonPrimitive(name) }
    }

    /** Only the fields that are set are sent (the engine keeps the others). */
    data class SetMix(
        val inputDb: Float? = null,
        val mainDb: Float? = null,
        val monitorDb: Float? = null,
        val monitorDry: Float? = null,
        val bypass: Boolean? = null,
        val mute: Boolean? = null,
    ) : ClientMsg("set_mix", Role.PERFORMER) {
        override fun fields(b: MutableMap<String, JsonElement>) {
            inputDb?.let { b["input_db"] = JsonPrimitive(it) }
            mainDb?.let { b["main_db"] = JsonPrimitive(it) }
            monitorDb?.let { b["monitor_db"] = JsonPrimitive(it) }
            monitorDry?.let { b["monitor_dry"] = JsonPrimitive(it.coerceIn(0f, 1f)) }
            bypass?.let { b["bypass"] = JsonPrimitive(it) }
            mute?.let { b["mute"] = JsonPrimitive(it) }
        }
    }

    data class Goto(val song: Int, val part: Int) : ClientMsg("goto", Role.PERFORMER) {
        override fun fields(b: MutableMap<String, JsonElement>) { b["song"] = JsonPrimitive(song); b["part"] = JsonPrimitive(part) }
    }

    data object Next : ClientMsg("next", Role.PERFORMER)
    data object Prev : ClientMsg("prev", Role.PERFORMER)
    data object TapTempo : ClientMsg("tap_tempo", Role.PERFORMER)
    data object Panic : ClientMsg("panic", Role.PERFORMER)
}

/** `latency_probe` = "idle" | "running" | {"done_ms": x} | "failed". */
fun Meters.latencyDoneMs(): Float? =
    runCatching { (latencyProbe as? JsonObject)?.get("done_ms")?.jsonPrimitive?.floatOrNull }.getOrNull()
