package ro.mixai.app.cast

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import androidx.media3.cast.Cast
import androidx.media3.common.util.UnstableApi

/**
 * Google Cast sender bootstrap (Media3 `media3-cast`, default media receiver via its DefaultCastOptionsProvider).
 * Cast is optional: on devices without Play services the init failure is logged and the cast button hides.
 */
@SuppressLint("UnsafeOptInUsageError")
@UnstableApi
object CastSupport {
    private const val TAG = "MixaiCast"
    @Volatile var available = false
        private set

    fun init(context: Context) {
        runCatching {
            val cast = Cast.getSingletonInstance(context)
            if (cast.needsInitialization()) cast.initialize()
            available = cast.castContextLoadFailure == null
        }.onFailure { Log.w(TAG, "cast init failed: ${it.message}") }
        Log.i(TAG, "cast available=$available")
    }
}
