package ro.mixai.tv.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import ro.mixai.tv.BuildConfig
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

// MixAI account sign-in — device-code flow on mixai.ro:
//   POST {origin}/api/device/code  {deviceName, platform, appVersion}
//     -> 200 {device_code, user_code:"ABCD-1234", verification_uri, verification_uri_complete, expires_in, interval}
//   POST {origin}/api/device/token {device_code}
//     -> 428 {error:"authorization_pending"} | 403 {error:"slow_down"|"access_denied"} | 410 {error:"expired_token"}
//     -> 200 {session_token, expires, user:{id,name,image}, companions:[{id,name,lanUrl,apiUrl,tunnelHostname,token}]}

@Serializable
data class DeviceCode(
    val device_code: String,
    val user_code: String,
    val verification_uri: String = "",
    val verification_uri_complete: String = "",
    val expires_in: Long = 900,
    val interval: Long = 5,
)

@Serializable
data class SessionUser(val id: String, val name: String? = null, val image: String? = null)

@Serializable
data class CompanionServer(
    val id: String = "",
    val name: String = "MMO Server",
    val lanUrl: String? = null,
    val apiUrl: String? = null,
    val tunnelHostname: String? = null,
    val token: String = "",
)

@Serializable
data class DeviceTokenOk(
    val session_token: String,
    val expires: String = "",
    val user: SessionUser,
    val companions: List<CompanionServer> = emptyList(),
)

sealed interface TokenResult {
    data object Pending : TokenResult
    data object SlowDown : TokenResult
    data object AccessDenied : TokenResult
    data object Expired : TokenResult
    data class Ok(val body: DeviceTokenOk) : TokenResult
}

/**
 * Thrown when mixai.ro is unreachable or answers something outside the contract. `status` 0 = network.
 * `kind` lets the UI pick a localised message (signin_err_*); `message` is a technical fallback.
 */
class DeviceAuthException(val status: Int, val kind: Kind, val host: String) :
    IOException("${kind.name.lowercase()} $host ($status)") {
    enum class Kind { Network, Status, Invalid }
}

class DeviceAuth(private val origin: String = BuildConfig.MIXAI_ORIGIN) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true; explicitNulls = false }
    val host: String = origin.substringAfter("://").substringBefore('/')

    suspend fun requestCode(deviceName: String, appVersion: String): DeviceCode {
        val body = """{"deviceName":${str(deviceName)},"platform":"android-tv","appVersion":${str(appVersion)}}"""
        val (code, text) = post("$origin/api/device/code", body)
        if (code !in 200..299) throw DeviceAuthException(code, DeviceAuthException.Kind.Status, host)
        return try { json.decodeFromString<DeviceCode>(text) } catch (e: Exception) {
            throw DeviceAuthException(code, DeviceAuthException.Kind.Invalid, host)
        }
    }

    suspend fun pollToken(deviceCode: String): TokenResult {
        val (code, text) = post("$origin/api/device/token", """{"device_code":${str(deviceCode)}}""")
        if (code == 200) {
            return try { TokenResult.Ok(json.decodeFromString<DeviceTokenOk>(text)) } catch (e: Exception) {
                throw DeviceAuthException(code, DeviceAuthException.Kind.Invalid, host)
            }
        }
        val err = try { (json.parseToJsonElement(text) as? JsonObject)?.get("error")?.jsonPrimitive?.content } catch (_: Exception) { null }
        return when {
            code == 428 || err == "authorization_pending" -> TokenResult.Pending
            err == "slow_down" -> TokenResult.SlowDown
            code == 403 || err == "access_denied" -> TokenResult.AccessDenied
            code == 410 || err == "expired_token" -> TokenResult.Expired
            else -> throw DeviceAuthException(code, DeviceAuthException.Kind.Status, host)
        }
    }

    /** `GET {base}/health` within `timeoutMs`; false on any failure. */
    suspend fun probeHealth(baseUrl: String, timeoutMs: Int = 2_000): Boolean = withContext(Dispatchers.IO) {
        try {
            val conn = (URL("$baseUrl/health").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"; connectTimeout = timeoutMs; readTimeout = timeoutMs
            }
            try { conn.responseCode in 200..299 } finally { conn.disconnect() }
        } catch (_: Exception) { false }
    }

    /** First companion whose `lanUrl` (then `apiUrl`) answers `/health`; null when none does. */
    suspend fun pickReachable(companions: List<CompanionServer>): Pair<CompanionServer, String>? {
        for (c in companions) {
            if (c.token.isBlank()) continue
            for (base in listOfNotNull(c.lanUrl, c.apiUrl).map { it.trimEnd('/') }.filter { it.isNotBlank() }) {
                if (probeHealth(base)) return c to base
            }
        }
        return null
    }

    private suspend fun post(url: String, body: String): Pair<Int, String> = withContext(Dispatchers.IO) {
        val conn = try {
            (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"; connectTimeout = 8_000; readTimeout = 15_000
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
            }
        } catch (e: Exception) { throw DeviceAuthException(0, DeviceAuthException.Kind.Network, host) }
        try {
            conn.outputStream.use { it.write(body.toByteArray()) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            code to (stream?.bufferedReader()?.use { it.readText() } ?: "")
        } catch (e: IOException) {
            throw DeviceAuthException(0, DeviceAuthException.Kind.Network, host)
        } finally {
            conn.disconnect()
        }
    }

    private fun str(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}
