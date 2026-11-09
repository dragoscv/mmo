package ro.mixai.decks.ui.platform

import android.view.Surface
import com.sun.jna.JNIEnv
import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.NativeLibrary

/**
 * `ANativeWindow_fromSurface` / `ANativeWindow_release` from libandroid.so through JNA direct
 * mapping, so the app needs no own JNI library to hand an `ANativeWindow*` to
 * `DecksRenderer.fromAndroidSurface`. A `jobject` parameter needs the `allow-objects` option.
 */
internal object AndroidNative {
    init {
        Native.register(AndroidNative::class.java, NativeLibrary.getInstance("android", mapOf(Library.OPTION_ALLOW_OBJECTS to true)))
    }

    @JvmStatic external fun ANativeWindow_fromSurface(env: JNIEnv, surface: Any): Long
    @JvmStatic external fun ANativeWindow_release(window: Long)

    fun windowFor(surface: Surface): Long = ANativeWindow_fromSurface(JNIEnv.CURRENT, surface)
}
