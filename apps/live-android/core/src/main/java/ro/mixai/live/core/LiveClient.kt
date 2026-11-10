package ro.mixai.live.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * Protocol v1 client over one OkHttp WebSocket (`/ws?t=<token>&c=<client-id>`). State goes through [reduce]; meters
 * are a separate [StateFlow] (read them in the draw phase). Reconnects with [backoffMillis] until [disconnect] or a
 * 401 (token rotated / wrong); pings every 10 s and drops a silent socket after 25 s.
 */
class LiveClient(
    private val clientId: String = "android-" + UUID.randomUUID().toString().take(12),
    private val metersHz: Int = 30,
    private val http: OkHttpClient = defaultHttp(),
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _state = MutableStateFlow(ClientState())
    val state: StateFlow<ClientState> = _state.asStateFlow()

    private val _meters = MutableStateFlow<Meters?>(null)
    val meters: StateFlow<Meters?> = _meters.asStateFlow()

    private val lock = Any()
    private var socket: WebSocket? = null
    private var generation = 0
    private var attempt = 0
    private var retryJob: Job? = null
    private var pingJob: Job? = null
    @Volatile private var lastRx = 0L
    private var nextId = 1
    private var wantMeters = true

    private fun dispatch(e: ClientEvent) = _state.update { reduce(it, e) }

    fun connect(engine: PairedEngine) {
        synchronized(lock) {
            closeLocked()
            attempt = 0
            dispatch(ClientEvent.Connect(engine))
            openLocked(engine)
        }
    }

    fun disconnect() {
        synchronized(lock) {
            closeLocked()
            dispatch(ClientEvent.Disconnect)
            _meters.value = null
        }
    }

    /** Pause/resume the meters stream (e.g. app in background) without dropping the connection. */
    fun setMeters(on: Boolean) {
        wantMeters = on
        if (!on) _meters.value = null
        rawSend(ClientMsg.Subscribe(meters = on, metersHz = metersHz).toJson())
    }

    /** Sends a control if connected and the role allows it; returns the message id or null. */
    fun send(msg: ClientMsg): Int? {
        if (!_state.value.can(msg.required)) return null
        val id = synchronized(lock) { nextId++ }
        return if (rawSend(msg.toJson(id))) id else null
    }

    fun clearError() = dispatch(ClientEvent.ClearError)

    /** GET /api/fx (effect catalogue with param ranges + curves). */
    suspend fun fetchFx(engine: PairedEngine = _state.value.engine ?: error("not paired")): List<FxSpec> =
        withContext(Dispatchers.IO) {
            val req = Request.Builder().url("${engine.httpBase}/api/fx").build()
            http.newCall(req).execute().use { r ->
                if (!r.isSuccessful) error("HTTP ${r.code}")
                LiveJson.decodeFromString(ListSerializer(FxSpec.serializer()), r.body.string())
            }
        }

    private fun rawSend(text: String): Boolean = synchronized(lock) { socket?.send(text) ?: false }

    private fun closeLocked() {
        generation++
        retryJob?.cancel(); retryJob = null
        pingJob?.cancel(); pingJob = null
        socket?.close(1000, null)
        socket = null
    }

    private fun openLocked(engine: PairedEngine) {
        val gen = ++generation
        val req = Request.Builder().url(engine.wsUrl(clientId)).build()
        socket = http.newWebSocket(req, Listener(gen, engine))
    }

    private fun current(gen: Int) = synchronized(lock) { gen == generation }

    private fun scheduleReconnect(gen: Int, engine: PairedEngine, unauthorized: Boolean) {
        synchronized(lock) {
            if (gen != generation) return
            socket = null
            pingJob?.cancel()
            val a = attempt++
            dispatch(ClientEvent.Closed(unauthorized, attempt))
            _meters.value = null
            val phase = _state.value.phase
            if (unauthorized || phase == Phase.UPDATE_REQUIRED || phase == Phase.IDLE) return
            retryJob = scope.launch {
                delay(backoffMillis(a, Random.nextDouble()))
                synchronized(lock) { if (gen == generation) openLocked(engine) }
            }
        }
    }

    private fun startPing(gen: Int, ws: WebSocket) {
        pingJob?.cancel()
        pingJob = scope.launch {
            while (isActive && current(gen)) {
                delay(PING_MS)
                if (now() - lastRx > DEAD_MS) {
                    ws.cancel()
                    break
                }
                ws.send(ClientMsg.Ping(now()).toJson())
            }
        }
    }

    private inner class Listener(private val gen: Int, private val engine: PairedEngine) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (!current(gen)) return
            lastRx = now()
            dispatch(ClientEvent.Opened)
            synchronized(lock) { startPing(gen, webSocket) }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!current(gen)) return
            lastRx = now()
            val msg = ServerMsg.parse(text) ?: return
            when (msg) {
                is ServerMsg.MetersMsg -> _meters.value = msg.meters
                is ServerMsg.Pong -> msg.t?.let { dispatch(ClientEvent.Rtt((now() - it).coerceAtLeast(0))) }
                else -> dispatch(ClientEvent.Message(msg, now()))
            }
            if (msg is ServerMsg.HelloMsg) {
                synchronized(lock) { attempt = 0 }
                webSocket.send(ClientMsg.Subscribe(meters = wantMeters, metersHz = metersHz).toJson())
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            scheduleReconnect(gen, engine, unauthorized = false)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            scheduleReconnect(gen, engine, unauthorized = response?.code == 401)
        }
    }

    companion object {
        const val PING_MS = 10_000L
        const val DEAD_MS = 25_000L

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(5, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }
}
