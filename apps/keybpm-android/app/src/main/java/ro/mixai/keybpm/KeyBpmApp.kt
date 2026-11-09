package ro.mixai.keybpm

import android.app.Application
import android.os.Build
import ro.mixai.mobile.MobileConfig
import ro.mixai.tv.data.ClientIdentity
import ro.mixai.tv.data.Settings

/**
 * Optional MMO Server connection (D69: offline by default, the library features appear once connected). Uses the
 * shared connect screens from `:mobile-common` and `:core`'s Settings store; no MixAI account is involved, so the
 * sign-in origins stay blank.
 */
class KeyBpmApp : Application() {
	lateinit var settings: Settings
		private set

	val config: MobileConfig by lazy {
		MobileConfig(origin = "", webOrigin = "", googleWebClientId = "", appVersion = BuildConfig.VERSION_NAME, deviceLabel = "MixAI Key & BPM")
	}

	override fun onCreate() {
		super.onCreate()
		ClientIdentity.current = ClientIdentity("android-keybpm", BuildConfig.VERSION_NAME, Build.MODEL ?: "Android", "MixAI-KeyBpm-Android")
		settings = Settings(this)
	}
}
