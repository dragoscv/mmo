package ro.mixai.keybpm.songid

import android.content.Context
import android.util.Base64
import com.shazam.shazamkit.AudioSampleRateInHz
import com.shazam.shazamkit.DeveloperToken
import com.shazam.shazamkit.DeveloperTokenProvider
import com.shazam.shazamkit.MatchError
import com.shazam.shazamkit.MatchResult
import com.shazam.shazamkit.Session
import com.shazam.shazamkit.ShazamKit
import com.shazam.shazamkit.ShazamKitResult
import com.shazam.shazamkit.Signature
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.Request
import ro.mixai.tv.data.Http

/**
 * ShazamKit for Android (WP18-06). The developer token comes from `mixai.ro/api/shazam/token` (WP18-17, 12 h ES256,
 * anonymous + `x-mixai-app`) and is cached in app-private prefs until an hour before expiry.
 */
class ShazamEngine(private val context: Context, private val tokenUrl: String) : SongIdEngine {
    override val available = true
    private val prefs = context.getSharedPreferences("shazam", Context.MODE_PRIVATE)
    private val mutex = Mutex()
    private var session: Session? = null

    private val tokens = DeveloperTokenProvider { DeveloperToken(currentToken()) }

    /** Blocking (ShazamKit calls the provider from its own worker thread). */
    private fun currentToken(): String {
        val now = System.currentTimeMillis() / 1000
        val cached = prefs.getString("token", null)
        if (cached != null && prefs.getLong("exp", 0) - now > 3600) return cached
        val req = Request.Builder().url(tokenUrl).header("x-mixai-app", "keybpm-android").build()
        Http.client.newCall(req).execute().use { res ->
            val body = res.body.string()
            if (!res.isSuccessful) throw IllegalStateException("token ${res.code}")
            val o = Json.parseToJsonElement(body).jsonObject
            val t = o["token"]!!.jsonPrimitive.content
            prefs.edit().putString("token", t).putLong("exp", o["expiresAt"]!!.jsonPrimitive.long).apply()
            return t
        }
    }

    private suspend fun session(): Session = mutex.withLock {
        session ?: run {
            val catalog = ShazamKit.createShazamCatalog(tokens, java.util.Locale.getDefault())
            when (val r = ShazamKit.createSession(catalog)) {
                is ShazamKitResult.Success -> r.data.also { session = it }
                is ShazamKitResult.Failure -> throw IllegalStateException("session ${r.reason.internalError}")
                else -> throw IllegalStateException("session")
            }
        }
    }

    override suspend fun identify(pcm16: ByteArray, sampleRate: Int, entryAtMillis: Long?): SongIdResult = withContext(Dispatchers.IO) {
        val rate = if (sampleRate == 44_100) AudioSampleRateInHz.SAMPLE_RATE_44100 else AudioSampleRateInHz.SAMPLE_RATE_48000
        val gen = when (val r = ShazamKit.createSignatureGenerator(rate)) {
            is ShazamKitResult.Success -> r.data
            is ShazamKitResult.Failure -> return@withContext SongIdResult.Failed("generator ${r.reason.internalError}")
            else -> return@withContext SongIdResult.Failed("generator")
        }
        // The whole window ends "now": stamp the start so the catalog can predict the live offset.
        val start = System.currentTimeMillis() - pcm16.size / 2L * 1000 / sampleRate
        gen.append(pcm16, pcm16.size, start)
        val sig = runCatching { gen.generateSignature() }.getOrElse { return@withContext SongIdResult.Failed("signature ${it.message}") }
        match(sig, entryAtMillis)
    }

    override suspend fun retry(stored: StoredSignature): SongIdResult = withContext(Dispatchers.IO) {
        val bytes = Base64.decode(stored.data, Base64.NO_WRAP)
        val sig = runCatching { rebuild(bytes, stored.durationMs, stored.createdAtMillis) }
            .getOrElse { return@withContext SongIdResult.Failed("stored signature ${it.javaClass.simpleName}") }
        match(sig, stored.entryAtMillis)
    }

    private suspend fun match(sig: Signature, entryAtMillis: Long?): SongIdResult {
        val s = runCatching { session() }.getOrElse { return queue(sig, entryAtMillis, it.message ?: "session") }
        return when (val r = runCatching { s.match(sig) }.getOrElse { return queue(sig, entryAtMillis, it.message ?: "match") }) {
            is MatchResult.Match -> r.matchedMediaItems.firstOrNull()?.let { m ->
                SongIdResult.Match(
                    SongMatch(
                        title = m.title ?: return SongIdResult.NoMatch,
                        artist = m.artist,
                        isrc = m.isrc,
                        shazamId = m.shazamID,
                        artworkUrl = m.artworkURL?.toString(),
                        appleMusicUrl = m.appleMusicURL?.toString(),
                        webUrl = m.webURL?.toString(),
                    ),
                )
            } ?: SongIdResult.NoMatch
            is MatchResult.NoMatch -> SongIdResult.NoMatch
            is MatchResult.Error -> when (r.exception.matchError) {
                MatchError.MATCH_ATTEMPT_FAILED -> queue(sig, entryAtMillis, "offline")
                MatchError.UNAUTHORIZED -> {
                    prefs.edit().clear().apply()
                    mutex.withLock { session = null }
                    SongIdResult.Failed("unauthorized")
                }
                else -> SongIdResult.Failed(r.exception.matchError.name.lowercase())
            }
            else -> SongIdResult.Failed("unknown")
        }
    }

    private fun queue(sig: Signature, entryAtMillis: Long?, reason: String): SongIdResult {
        val stored = StoredSignature(Base64.encodeToString(sig.dataRepresentation, Base64.NO_WRAP), sig.durationInMs, System.currentTimeMillis(), entryAtMillis)
        PendingSignatures(context).add(stored)
        return SongIdResult.Queued(reason)
    }

    /**
     * Re-creates a [Signature] from stored bytes. Its constructor and `OffsetTimestamp` are Kotlin-internal in the
     * AAR (public in bytecode), so go through reflection + a dynamic proxy for the timestamp.
     */
    private fun rebuild(bytes: ByteArray, durationMs: Long, createdAt: Long): Signature {
        val tsClass = Class.forName("com.shazam.shazamkit.internal.OffsetTimestamp")
        fun stamp(at: Long): Any = java.lang.reflect.Proxy.newProxyInstance(tsClass.classLoader, arrayOf(tsClass)) { _, method, args ->
            when (method.name) {
                "getTimePassedSinceTimestampInMs" -> System.currentTimeMillis() - at
                "add" -> stamp(at + (args!![0] as Double).toLong())
                "hashCode" -> at.hashCode()
                "equals" -> false
                "toString" -> "Stamp($at)"
                else -> null
            }
        }
        val ctor = Signature::class.java.getConstructor(ByteArray::class.java, java.lang.Long.TYPE, tsClass)
        return ctor.newInstance(bytes, durationMs, stamp(createdAt)) as Signature
    }
}

fun createSongIdEngine(context: Context, tokenUrl: String): SongIdEngine = ShazamEngine(context, tokenUrl)
