package ro.mixai.mobile.auth

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import ro.mixai.tv.data.ApiException
import ro.mixai.tv.data.Http

/** `/api/auth/native/google` answer (subset). */
@Serializable
data class NativeSessionUser(val id: String = "", val name: String? = null, val email: String? = null, val image: String? = null)

@Serializable
data class NativeSession(val session_token: String = "", val sessionToken: String = "", val expires: String = "", val user: NativeSessionUser = NativeSessionUser()) {
    val token: String get() = sessionToken.ifBlank { session_token }
}

internal fun jsonStr(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\""

// Calls to the MixAI web ([MobileConfig.webOrigin]): native Google sign-in exchange and push token
// registration. Bearer = native session token (never logged).

class WebApi(val origin: String) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true }
    private val type = "application/json".toMediaType()

    /** `POST /api/auth/native/google {idToken, nonce?}` → session. */
    suspend fun nativeGoogle(idToken: String, nonce: String?): NativeSession {
        val body = "{\"idToken\":${jsonStr(idToken)}" + (nonce?.let { ",\"nonce\":${jsonStr(it)}" } ?: "") + "}"
        return json.decodeFromString(call("POST", "/api/auth/native/google", body, bearer = null).second)
    }

    /** `POST /api/push/register` → HTTP status (200 ok, 401 no session, 503 push unavailable). */
    suspend fun registerPush(bearer: String, token: String, deviceName: String, profileId: String?): Int {
        val body = buildString {
            append("{\"platform\":\"android\",\"token\":").append(jsonStr(token))
            append(",\"deviceName\":").append(jsonStr(deviceName.take(120)))
            profileId?.takeIf { it.isNotBlank() }?.let { append(",\"profileId\":").append(jsonStr(it)) }
            append("}")
        }
        return call("POST", "/api/push/register", body, bearer, throwOnError = false).first
    }

    suspend fun unregisterPush(bearer: String, token: String): Int =
        call("DELETE", "/api/push/register", "{\"token\":${jsonStr(token)}}", bearer, throwOnError = false).first

    private suspend fun call(method: String, path: String, body: String?, bearer: String?, throwOnError: Boolean = true): Pair<Int, String> =
        withContext(Dispatchers.IO) {
            val req = Request.Builder().url(origin + path).method(method, body?.toRequestBody(type))
                .header("Accept", "application/json")
                .apply { if (!bearer.isNullOrBlank()) header("Authorization", "Bearer $bearer") }
                .build()
            Http.client.newCall(req).execute().use { res ->
                val text = res.body.string()
                if (!res.isSuccessful) {
                    Log.w(TAG, "$method $path -> ${res.code}")
                    if (throwOnError) throw ApiException(res.code, text.take(200))
                }
                res.code to text
            }
        }

    private companion object { const val TAG = "MixaiWeb" }
}
