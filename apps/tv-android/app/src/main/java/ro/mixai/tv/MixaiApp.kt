package ro.mixai.tv

import android.app.Application
import ro.mixai.tv.data.Settings

class MixaiApp : Application() {
    lateinit var settings: Settings
        private set

    override fun onCreate() {
        super.onCreate()
        settings = Settings(this)
    }
}
