package ro.mixai.decks.ffi

import android.content.Context

/**
 * Gives the Rust audio engine (cpal → AAudio) the JavaVM + application Context it needs.
 * Call once before the first `DecksEngine.start()`; repeated calls are no-ops (Rust side uses `Once`).
 */
object DecksAndroid {
    @Volatile private var done = false

    fun init(context: Context) {
        if (done) return
        System.loadLibrary("decks_ffi")
        nativeInit(context.applicationContext)
        done = true
    }

    @JvmStatic private external fun nativeInit(context: Context)
}
