package ro.mixai.tv.data

import android.os.Build
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import ro.mixai.tv.BuildConfig
import ro.mixai.tv.data.generated.HubDevice
import ro.mixai.tv.data.generated.HubMedia

/** Remote command received from the hub (`cmd {from, action, args, seq}`). */
data class HubCommand(val action: String, val args: JsonObject, val seq: String, val fromName: String = "", val fromDeviceId: String = "")

/** Room member (`room:members`). */
data class RoomMember(val connId: String, val name: String, val ready: Boolean, val guest: Boolean)

/** Watch Together room snapshot as seen by this device. */
data class RoomState(
    val roomId: String,
    val name: String = "",
    /** idle | waiting | playing | paused */
    val phase: String = "idle",
    val media: HubMedia? = null,
    val anchor: PlaybackAnchor = PlaybackAnchor(false, 0.0, 0.0),
    val members: List<RoomMember> = emptyList(),
    val hostConnId: String? = null,
    /** Invite secret for guests (`/hub/invite/{invite}`; web join link); null for guests. */
    val invite: String? = null,
)

data class RoomChat(val fromName: String, val fromConnId: String, val text: String, val ts: Long)
data class RoomReaction(val fromName: String, val emoji: String, val mediaSec: Double, val ts: Long)

enum class HubStatus { Disconnected, Connecting, Connected }

// WebSocket client for the MMO Server hub (`WS /hub?t=<token>`, protocol in server/src/hub/core.ts).
// Registers this TV (`hello`), keeps a clock offset (`time` pings → [ClockEstimator]), receives
// remote commands and runs Watch Together rooms. Auto-reconnects with exponential backoff
// (1 s → 30 s). Everything is safe to call while disconnected (messages are dropped).
class HubClient(
    private val api: MmoApi,
    private val settings: Settings,
    private val profileId: () -> String? = { null },
) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true; explicitNulls = false }
    private var scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var ws: WebSocket? = null
    @Volatile private var running = false
    private var loopJob: Job? = null
    private var pingJob: Job? = null
    private var stateJob: Job? = null

    val clock = ClockEstimator()

    private val _status = MutableStateFlow(HubStatus.Disconnected)
    val status: StateFlow<HubStatus> = _status.asStateFlow()

    private val _commands = MutableSharedFlow<HubCommand>(extraBufferCapacity = 32)
    val incomingCommands: SharedFlow<HubCommand> = _commands.asSharedFlow()

    private val _devices = MutableStateFlow<List<HubDevice>>(emptyList())
    /** Other devices on the hub (from `devices` broadcasts). */
    val devices: StateFlow<List<HubDevice>> = _devices.asStateFlow()

    private val _room = MutableStateFlow<RoomState?>(null)
    val room: StateFlow<RoomState?> = _room.asStateFlow()

    private val _chat = MutableSharedFlow<RoomChat>(extraBufferCapacity = 64)
    val chat: SharedFlow<RoomChat> = _chat.asSharedFlow()

    private val _reactions = MutableSharedFlow<RoomReaction>(extraBufferCapacity = 64)
    val reactions: SharedFlow<RoomReaction> = _reactions.asSharedFlow()

    private val _errors = MutableSharedFlow<String>(extraBufferCapacity = 8)
    /** Server `error {error}` codes (room_not_found, room_full, not_in_room). */
    val errors: SharedFlow<String> = _errors.asSharedFlow()

    @Volatile var myConnId: String? = null
        private set

    /** Server time estimate in ms. */
    fun serverNowMs(): Double = System.currentTimeMillis() + clock.offsetMs

    /** Where the room's media should be right now (seconds), or null outside a room. */
    fun roomExpectedPosition(): Double? = _room.value?.let { expectedPosition(it.anchor, serverNowMs()) }

    // ─── lifecycle ────────────────────────────────────────────────────────

    fun start() {
        if (running) return
        running = true
        if (!scope.coroutineContextActive()) scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        loopJob = scope.launch { connectLoop() }
        // Forward the player's now-playing to the hub.
        stateJob = scope.launch {
            var last: NowPlaying? = null
            PlayerBus.nowPlaying.collect { np ->
                if (np == null && last == null) return@collect
                last = np
                if (np == null) sendRaw(buildJsonObject { put("type", "state"); put("idle", true) })
                else reportState(np.playing, np.positionSec, np.durationSec, np.media)
            }
        }
    }

    fun stop() {
        running = false
        loopJob?.cancel(); pingJob?.cancel(); stateJob?.cancel()
        ws?.close(1000, "bye"); ws = null
        _status.value = HubStatus.Disconnected
        scope.cancel()
    }

    private fun CoroutineScope.coroutineContextActive(): Boolean = coroutineContext[Job]?.isActive == true

    private suspend fun connectLoop() {
        var backoff = 1_000L
        while (running) {
            val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
            _status.value = HubStatus.Connecting
            val req = Request.Builder().url(api.hubUrl()).build()
            var opened = false
            val socket = Http.ws.newWebSocket(req, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    opened = true
                    ws = webSocket
                    _status.value = HubStatus.Connected
                    scope.launch { sendHello() }
                    startPings()
                }
                override fun onMessage(webSocket: WebSocket, text: String) { handle(text) }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { closed.complete(Unit) }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.w(TAG, "hub ws failure: ${t.message} (${response?.code})")
                    closed.complete(Unit)
                }
            })
            closed.await()
            if (ws === socket) ws = null
            pingJob?.cancel()
            _status.value = HubStatus.Disconnected
            val hadRoom = _room.value?.roomId
            if (!running) break
            backoff = if (opened) 1_000L else (backoff * 2).coerceAtMost(30_000L)
            delay(backoff)
            // Rejoin the room after a reconnect (new connId on the server).
            if (hadRoom != null) pendingRejoin = hadRoom
        }
    }

    @Volatile private var pendingRejoin: String? = null

    private fun startPings() {
        pingJob?.cancel()
        pingJob = scope.launch {
            repeat(3) { ping(); delay(1_000) }
            while (true) { delay(30_000); ping() }
        }
    }

    private fun ping() = sendRaw(buildJsonObject { put("type", "time"); put("t0", System.currentTimeMillis()) })

    private suspend fun sendHello() {
        val name = settings.deviceName.firstOrNullSafe()?.ifBlank { null } ?: Build.MODEL ?: "Android TV"
        sendRaw(buildJsonObject {
            put("type", "hello")
            put("deviceId", settings.deviceId())
            put("name", name)
            put("platform", "android-tv")
            put("caps", JsonArray(CAPS.map { JsonPrimitive(it) }))
            profileId()?.let { put("profileId", it) }
            put("app", "mixai-tv/${BuildConfig.VERSION_NAME}")
        })
        pendingRejoin?.let { joinRoom(it); pendingRejoin = null }
    }

    /** Re-sends `hello` (profile changed, device renamed). */
    fun refreshHello() { scope.launch { sendHello() } }

    // ─── inbound ──────────────────────────────────────────────────────────

    private fun handle(text: String) {
        val msg = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (msg.str("type")) {
            "welcome" -> myConnId = msg["you"]?.jsonObjectOrNull()?.str("connId")
            "time" -> {
                val t3 = System.currentTimeMillis().toDouble()
                val t0 = msg.num("t0") ?: return
                val t1 = msg.num("t1") ?: return
                val t2 = msg.num("t2") ?: return
                clock.add(sampleFrom(t0, t1, t2, t3))
            }
            "cmd" -> {
                val from = msg["from"]?.jsonObjectOrNull()
                _commands.tryEmit(HubCommand(
                    action = msg.str("action") ?: return,
                    args = msg["args"]?.jsonObjectOrNull() ?: JsonObject(emptyMap()),
                    seq = msg.str("seq") ?: "",
                    fromName = from?.str("name") ?: "",
                    fromDeviceId = from?.str("deviceId") ?: "",
                ))
            }
            "devices" -> _devices.value = runCatching {
                msg["devices"]?.jsonArray?.map { json.decodeFromJsonElement(HubDevice.serializer(), it) }
            }.getOrNull() ?: emptyList()
            "room:created", "room:joined" -> {
                val id = msg.str("roomId") ?: return
                val cur = _room.value
                _room.value = (if (cur?.roomId == id) cur else RoomState(id)).copy(
                    name = msg.str("name") ?: cur?.name ?: "",
                    invite = msg.str("invite") ?: cur?.invite,
                )
            }
            "room:state" -> {
                val id = msg.str("roomId") ?: return
                val a = msg["anchor"]?.jsonObjectOrNull()
                val anchor = PlaybackAnchor(
                    playing = a?.bool("playing") == true,
                    positionSec = a?.num("positionSec") ?: 0.0,
                    atServerMs = a?.num("atServerMs") ?: 0.0,
                    rate = a?.num("rate"),
                )
                val media = msg["media"]?.takeIf { it !is JsonNull }?.let { runCatching { json.decodeFromJsonElement(HubMedia.serializer(), it) }.getOrNull() }
                val cur = _room.value?.takeIf { it.roomId == id } ?: RoomState(id)
                _room.value = cur.copy(phase = msg.str("phase") ?: cur.phase, media = media, anchor = anchor)
            }
            "room:members" -> {
                val id = msg.str("roomId") ?: return
                val members = msg["members"]?.jsonArray?.mapNotNull { e ->
                    val o = e.jsonObjectOrNull() ?: return@mapNotNull null
                    RoomMember(o.str("connId") ?: "", o.str("name") ?: "", o.bool("ready") == true, o.bool("guest") == true)
                } ?: emptyList()
                val cur = _room.value?.takeIf { it.roomId == id } ?: RoomState(id)
                _room.value = cur.copy(members = members, hostConnId = msg.str("hostConnId"))
            }
            "room:chat" -> {
                val from = msg["from"]?.jsonObjectOrNull()
                _chat.tryEmit(RoomChat(from?.str("name") ?: "", from?.str("connId") ?: "", msg.str("text") ?: return, msg.num("ts")?.toLong() ?: 0L))
            }
            "room:react" -> {
                val from = msg["from"]?.jsonObjectOrNull()
                _reactions.tryEmit(RoomReaction(from?.str("name") ?: "", msg.str("emoji") ?: return, msg.num("mediaSec") ?: 0.0, msg.num("ts")?.toLong() ?: 0L))
            }
            "room:left" -> if (_room.value?.roomId == msg.str("roomId")) _room.value = null
            "error" -> msg.str("error")?.let { _errors.tryEmit(it) }
        }
    }

    // ─── outbound: remote control ─────────────────────────────────────────

    /** Acknowledge a [HubCommand]. `state` is optional extra info for the controller. */
    fun ack(seq: String, ok: Boolean, error: String? = null, state: JsonObject? = null) {
        if (seq.isBlank()) return
        sendRaw(buildJsonObject {
            put("type", "ack"); put("seq", seq); put("ok", ok)
            error?.let { put("error", it) }
            state?.let { put("state", it) }
        })
    }

    fun reportState(playing: Boolean, positionSec: Double, durationSec: Double?, media: HubMedia?) {
        sendRaw(buildJsonObject {
            put("type", "state"); put("playing", playing); put("positionSec", positionSec)
            durationSec?.let { put("durationSec", it) }
            media?.let { put("media", json.encodeToJsonElement(HubMedia.serializer(), it)) }
        })
    }

    /** Send a command to another device (this TV as a remote). */
    fun command(targetDeviceId: String, action: String, args: JsonObject = JsonObject(emptyMap())): String {
        val seq = java.util.UUID.randomUUID().toString()
        sendRaw(buildJsonObject { put("type", "cmd"); put("target", targetDeviceId); put("action", action); put("args", args); put("seq", seq) })
        return seq
    }

    // ─── outbound: Watch Together ─────────────────────────────────────────

    fun createRoom(name: String? = null) = sendRaw(buildJsonObject { put("type", "room:create"); name?.let { put("name", it) } })
    fun joinRoom(roomId: String) = sendRaw(buildJsonObject { put("type", "room:join"); put("roomId", roomId) })
    fun leave() { sendRaw(buildJsonObject { put("type", "room:leave") }); _room.value = null }
    fun load(media: HubMedia, positionSec: Double = 0.0) = sendRaw(buildJsonObject {
        put("type", "room:load"); put("media", json.encodeToJsonElement(HubMedia.serializer(), media)); put("positionSec", positionSec)
    })
    fun play(positionSec: Double? = null) = sendRaw(buildJsonObject { put("type", "room:play"); positionSec?.let { put("positionSec", it) } })
    fun pause(positionSec: Double? = null) = sendRaw(buildJsonObject { put("type", "room:pause"); positionSec?.let { put("positionSec", it) } })
    fun seek(positionSec: Double) = sendRaw(buildJsonObject { put("type", "room:seek"); put("positionSec", positionSec) })
    fun ready(ready: Boolean, positionSec: Double? = null) = sendRaw(buildJsonObject {
        put("type", "room:ready"); put("ready", ready); positionSec?.let { put("positionSec", it) }
    })
    /** 1 Hz while playing in a room. */
    fun report(positionSec: Double) = sendRaw(buildJsonObject { put("type", "room:report"); put("positionSec", positionSec); put("rttMs", clock.rttMs) })
    fun chat(text: String) = sendRaw(buildJsonObject { put("type", "room:chat"); put("text", text) })
    fun react(emoji: String, mediaSec: Double? = null) = sendRaw(buildJsonObject { put("type", "room:react"); put("emoji", emoji); mediaSec?.let { put("mediaSec", it) } })

    private fun sendRaw(o: JsonObject): Boolean = ws?.send(o.toString()) ?: false

    companion object {
        private const val TAG = "HubClient"
        val CAPS = listOf("play", "pause", "seek", "stop", "next", "previous", "text", "navigate")
    }
}

// ─── small JSON helpers ─────────────────────────────────────────────────────

private fun JsonElement.jsonObjectOrNull(): JsonObject? = this as? JsonObject
private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
private fun JsonObject.num(k: String): Double? = (this[k] as? JsonPrimitive)?.doubleOrNull
private fun JsonObject.bool(k: String): Boolean? = (this[k] as? JsonPrimitive)?.booleanOrNull

/** Typed accessors for [HubCommand.args]. */
fun JsonObject.argString(k: String): String? = (this[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
fun JsonObject.argDouble(k: String): Double? = (this[k] as? JsonPrimitive)?.doubleOrNull
fun JsonObject.argLong(k: String): Long? = argDouble(k)?.toLong()

private suspend fun kotlinx.coroutines.flow.Flow<String>.firstOrNullSafe(): String? =
    runCatching { first() }.getOrNull()
