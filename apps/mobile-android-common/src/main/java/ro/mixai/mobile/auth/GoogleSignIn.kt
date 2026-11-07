package ro.mixai.mobile.auth

import android.content.Context
import android.util.Log
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import ro.mixai.mobile.MobileConfig
import java.security.MessageDigest
import java.security.SecureRandom
import android.util.Base64

sealed interface GoogleSignInResult {
    data class Ok(val session: NativeSession) : GoogleSignInResult
    data object Cancelled : GoogleSignInResult
    /** No Google account on the device (or none allowed) → device-code fallback. */
    data object NoAccount : GoogleSignInResult
    data class Failed(val message: String) : GoogleSignInResult
}

/**
 * Native Google sign-in: Credential Manager `GetGoogleIdOption` for the web OAuth client
 * (`config.googleWebClientId` = apps/web AUTH_GOOGLE_ID) → `POST /api/auth/native/google {idToken, nonce}`.
 * The raw nonce goes to the server; Google gets its SHA-256 (server verifies the claim).
 */
object GoogleSignIn {
    private const val TAG = "MixaiAuth"

    suspend fun signIn(activityContext: Context, web: WebApi, config: MobileConfig): GoogleSignInResult {
        val raw = ByteArray(24).also { SecureRandom().nextBytes(it) }
        val nonce = Base64.encodeToString(raw, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        val option = GetGoogleIdOption.Builder()
            .setServerClientId(config.googleWebClientId)
            .setFilterByAuthorizedAccounts(false)
            .setAutoSelectEnabled(false)
            .setNonce(sha256Hex(nonce))
            .build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
        val credential = try {
            CredentialManager.create(activityContext).getCredential(activityContext, request).credential
        } catch (e: GetCredentialCancellationException) {
            return GoogleSignInResult.Cancelled
        } catch (e: NoCredentialException) {
            return GoogleSignInResult.NoAccount
        } catch (e: Exception) {
            Log.w(TAG, "credential manager: ${e.javaClass.simpleName} ${e.message}")
            return GoogleSignInResult.Failed(e.message ?: e.javaClass.simpleName)
        }
        if (credential !is CustomCredential || credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            return GoogleSignInResult.Failed("unexpected credential")
        }
        val idToken = GoogleIdTokenCredential.createFrom(credential.data).idToken
        return try {
            val s = web.nativeGoogle(idToken, sha256Hex(nonce))
            if (s.token.isBlank()) GoogleSignInResult.Failed("no session") else GoogleSignInResult.Ok(s)
        } catch (e: Exception) {
            Log.w(TAG, "native exchange failed: ${e.message?.take(120)}")
            GoogleSignInResult.Failed(e.message ?: "exchange failed")
        }
    }

    private fun sha256Hex(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}
