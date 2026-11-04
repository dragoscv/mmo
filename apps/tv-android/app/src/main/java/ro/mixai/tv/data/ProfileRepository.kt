package ro.mixai.tv.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import ro.mixai.tv.data.generated.Profile
import ro.mixai.tv.data.generated.ProfileInput

/** Result of [ProfileRepository.unlock]. */
sealed interface UnlockResult {
    data class Ok(val profile: Profile) : UnlockResult
    /** Wrong PIN; `triesLeft` before the 5-minute lock (null when the server did not say). */
    data class WrongPin(val triesLeft: Int?) : UnlockResult
    /** Too many wrong PINs — retry after `retryAfterMs`. */
    data class Locked(val retryAfterMs: Long) : UnlockResult
    data class Failed(val message: String) : UnlockResult
}

// Viewer profiles owned by MMO Server (`/media/profiles*`, WP16-02). Holds the active profile +
// its 12 h unlock token, persists both in [Settings] and feeds `x-profile-token` into every
// authenticated MmoApi call (via `MmoApi.extraHeaders`).
class ProfileRepository(private val api: MmoApi, private val settings: Settings) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true; explicitNulls = false }

    private val _profiles = MutableStateFlow<List<Profile>>(emptyList())
    /** Last list from the server (empty until [refresh]). */
    val profiles: StateFlow<List<Profile>> = _profiles.asStateFlow()

    private val _active = MutableStateFlow<Profile?>(null)
    /** Profile currently watching; null until chosen/restored. */
    val activeProfile: StateFlow<Profile?> = _active.asStateFlow()

    @Volatile private var token: String = ""
    @Volatile private var tokenExp: Long = 0L

    init {
        api.extraHeaders = { if (token.isNotBlank() && tokenExp > System.currentTimeMillis()) mapOf("x-profile-token" to token) else emptyMap() }
    }

    /** Id used for `?profile=` (`"default"` until a profile is chosen). */
    val activeId: String get() = _active.value?.id ?: "default"

    /** Current profile token (blank when none / expired). */
    val profileToken: String get() = if (tokenExp > System.currentTimeMillis()) token else ""

    suspend fun refresh(): List<Profile> {
        val page = json.decodeFromString<ProfilesPage>(api.getJson("/media/profiles"))
        val list = page.profiles.sortedWith(compareBy({ it.sort }, { it.createdAt }))
        _profiles.value = list
        _active.value?.let { a -> _active.value = list.firstOrNull { it.id == a.id } ?: a }
        return list
    }

    /**
     * Restores the persisted active profile (and token while valid). Returns true when the stored
     * profile still exists and is usable without a PIN prompt.
     */
    suspend fun restore(): Boolean {
        val saved = settings.activeProfile.first()
        val list = runCatching { refresh() }.getOrElse { _profiles.value }
        val p = list.firstOrNull { it.id == saved.id } ?: return false
        if (saved.tokenValid()) { token = saved.token; tokenExp = saved.expiresAt }
        _active.value = p
        return !p.hasPin || saved.tokenValid()
    }

    /**
     * True when startup must show the profile picker: more than one profile, or the only/active
     * profile has a PIN without a valid token.
     */
    suspend fun needsPicker(): Boolean {
        val restoredOk = restore()
        val list = _profiles.value
        if (list.size > 1) return true
        val only = list.firstOrNull() ?: return false
        if (only.hasPin && !restoredOk) return true
        if (_active.value == null) select(only)
        return false
    }

    /** Selects a profile without a PIN (or with a still-valid token). */
    suspend fun select(profile: Profile) {
        val sameTokenValid = profile.id == _active.value?.id && tokenExp > System.currentTimeMillis()
        if (!sameTokenValid) { token = ""; tokenExp = 0L }
        _active.value = profile
        settings.saveActiveProfile(profile.id, token, tokenExp)
    }

    /** `POST /media/profiles/{id}/unlock` with an optional 4-digit PIN; activates the profile on success. */
    suspend fun unlock(profile: Profile, pin: String?): UnlockResult {
        val body = if (pin != null) """{"pin":"$pin"}""" else "{}"
        return try {
            val res = json.decodeFromString<ProfileUnlock>(api.postJson("/media/profiles/${api.encode(profile.id)}/unlock", body))
            token = res.token; tokenExp = res.expiresAt
            _active.value = profile
            settings.saveActiveProfile(profile.id, res.token, res.expiresAt)
            UnlockResult.Ok(profile)
        } catch (e: ApiException) {
            val err = runCatching { json.decodeFromString<ProfileUnlockError>(e.message?.substringAfter(": ") ?: "") }.getOrNull()
            when (e.status) {
                401 -> UnlockResult.WrongPin(err?.triesLeft)
                429 -> UnlockResult.Locked(err?.retryAfterMs ?: 300_000L)
                else -> UnlockResult.Failed(e.message ?: "HTTP ${e.status}")
            }
        } catch (e: Exception) {
            UnlockResult.Failed(e.message ?: e.javaClass.simpleName)
        }
    }

    suspend fun create(input: ProfileInput): Profile {
        val res = json.decodeFromString<ProfileEnvelope>(api.postJson("/media/profiles", json.encodeToString(ProfileInput.serializer(), input)))
        runCatching { refresh() }
        return res.profile
    }

    /** Needs the profile's token when it has a PIN (unlock it first). */
    suspend fun update(id: String, input: ProfileInput): Profile {
        val res = json.decodeFromString<ProfileEnvelope>(api.patchJson("/media/profiles/${api.encode(id)}", json.encodeToString(ProfileInput.serializer(), input)))
        runCatching { refresh() }
        if (_active.value?.id == id) _active.value = res.profile
        return res.profile
    }

    suspend fun delete(id: String) {
        api.deleteJson("/media/profiles/${api.encode(id)}")
        if (_active.value?.id == id) { _active.value = null; token = ""; tokenExp = 0L; settings.saveActiveProfile("") }
        runCatching { refresh() }
    }

    /** Forget the active profile (e.g. "Switch profile"). */
    suspend fun signOutProfile() {
        _active.value = null; token = ""; tokenExp = 0L
        settings.saveActiveProfile("")
    }
}

/** Kids profiles (`kind == "kid"`). */
val Profile.isKid: Boolean get() = kind == "kid"
