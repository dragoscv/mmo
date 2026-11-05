package ro.mixai.tv.ui.profiles

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import ro.mixai.tv.data.ApiException
import ro.mixai.tv.data.Http
import ro.mixai.tv.data.MmoApi
import ro.mixai.tv.data.ProfileRepository
import ro.mixai.tv.data.UnlockResult
import ro.mixai.tv.data.generated.Profile
import ro.mixai.tv.data.generated.ProfileInput

/**
 * Profile management that must NOT switch the active profile: editing/deleting another PIN
 * profile needs that profile's own `x-profile-token`, while [ProfileRepository.unlock] would make
 * it the active viewer. Tokens obtained here live only in memory for this screen.
 */
class ProfileAdmin(private val api: MmoApi, private val repo: ProfileRepository) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val tokens = mutableMapOf<String, Pair<String, Long>>()

    /** True when a write to [p] can go ahead without asking for its PIN. */
    fun canWrite(p: Profile): Boolean =
        !p.hasPin || tokenFor(p.id) != null || (p.id == repo.activeProfile.value?.id && repo.profileToken.isNotBlank())

    private fun tokenFor(id: String): String? = tokens[id]?.takeIf { it.second > System.currentTimeMillis() + 30_000 }?.first

    /** `POST /media/profiles/{id}/unlock` without activating the profile. */
    suspend fun unlock(p: Profile, pin: String): UnlockResult = withContext(Dispatchers.IO) {
        try {
            val res = call("POST", "/media/profiles/${api.encode(p.id)}/unlock", """{"pin":"$pin"}""", null)
            val o = json.parseToJsonElement(res).jsonObject
            val tok = o["token"]?.jsonPrimitive?.contentOrNull ?: return@withContext UnlockResult.Failed("no token")
            tokens[p.id] = tok to (o["expiresAt"]?.jsonPrimitive?.longOrNull ?: (System.currentTimeMillis() + 600_000))
            UnlockResult.Ok(p)
        } catch (e: ApiException) {
            val body = runCatching { json.parseToJsonElement(e.message?.substringAfter(": ") ?: "").jsonObject }.getOrNull()
            when (e.status) {
                401 -> UnlockResult.WrongPin(body?.get("triesLeft")?.jsonPrimitive?.longOrNull?.toInt())
                429 -> UnlockResult.Locked(body?.get("retryAfterMs")?.jsonPrimitive?.longOrNull ?: 300_000L)
                else -> UnlockResult.Failed(e.message ?: "HTTP ${e.status}")
            }
        } catch (e: Exception) {
            UnlockResult.Failed(e.message ?: e.javaClass.simpleName)
        }
    }

    suspend fun create(input: ProfileInput): Profile = repo.create(input)

    /**
     * `PATCH /media/profiles/{id}` with a raw body: `ProfileInput` drops nulls, but removing a PIN
     * (`"pin": null`) or an age limit (`"maxAge": null`) needs an explicit JSON null.
     */
    suspend fun update(p: Profile, body: JsonObject) {
        withContext(Dispatchers.IO) { call("PATCH", "/media/profiles/${api.encode(p.id)}", body.toString(), writeToken(p)) }
        if (body["pin"] is JsonNull) tokens.remove(p.id)
        runCatching { repo.refresh() }
    }

    suspend fun delete(p: Profile) {
        val active = p.id == repo.activeProfile.value?.id
        if (active) { repo.delete(p.id); return }
        withContext(Dispatchers.IO) { call("DELETE", "/media/profiles/${api.encode(p.id)}", null, writeToken(p)) }
        tokens.remove(p.id)
        runCatching { repo.refresh() }
    }

    private fun writeToken(p: Profile): String? =
        tokenFor(p.id) ?: repo.profileToken.takeIf { p.id == repo.activeProfile.value?.id && it.isNotBlank() }

    private fun call(method: String, path: String, body: String?, profileToken: String?): String {
        val rb = (body ?: "").toRequestBody(JSON_TYPE).takeIf { body != null || method != "DELETE" }
        val req = Request.Builder().url(api.baseUrl + path).method(method, rb).header("Accept", "application/json").apply {
            api.authHeaders().forEach { (k, v) -> header(k, v) }
            if (profileToken != null) header("x-profile-token", profileToken)
        }.build()
        Http.client.newCall(req).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) throw ApiException(res.code, text.take(200))
            return text
        }
    }

    private companion object {
        val JSON_TYPE = "application/json".toMediaType()
    }
}

// ─── per-profile preferences (`Profile.prefs`, merged server-side on PATCH) ────

object ProfilePrefKeys {
    const val AUTOPLAY_NEXT = "autoplayNext"
    const val SKIP_INTRO = "skipIntro"
    const val AUDIO_LANG = "audioLang"
    const val SUB_LANG = "subLang"
    const val SUB_FORCED_ONLY = "subForcedOnly"
    const val SUB_SIZE = "subSize"
    const val SUB_BG = "subBg"
    /** true / false / "system" (= follow Android's animator scale); same key as the web prefs. */
    const val REDUCE_MOTION = "reduceMotion"
}

fun Profile.prefBool(key: String, default: Boolean): Boolean =
    (prefs[key] as? JsonPrimitive)?.booleanOrNull ?: default

fun Profile.prefString(key: String, default: String): String =
    (prefs[key] as? JsonPrimitive)?.contentOrNull ?: default

fun prefValue(v: Any): JsonElement = when (v) {
    is Boolean -> JsonPrimitive(v)
    is Number -> JsonPrimitive(v)
    else -> JsonPrimitive(v.toString())
}
