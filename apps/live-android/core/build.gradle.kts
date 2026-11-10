// MixAI Live controller core (WP21-08, ADR-0015): protocol v1 models (docs/live/remote-protocol.md), the OkHttp
// WebSocket client with reconnect + ping, a pure reducer, pairing-link parsing, mDNS discovery (NsdManager) and the
// paired-engine store (DataStore). No Rust/FFI: the engine is reached only over the LAN. Used by :live and :live-wear.
// AGP 9 ships built-in Kotlin: no `org.jetbrains.kotlin.android` plugin.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "ro.mixai.live.core"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        minSdk = libs.versions.minSdk.get().toInt()
    }

    buildTypes {
        release { isMinifyEnabled = false }
        create("benchmark") { initWith(getByName("release")) }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.android)
    api(libs.okhttp)
    api(libs.datastore.preferences)
    implementation(libs.androidx.core.ktx)

    testImplementation(libs.junit)
    testImplementation(libs.mockwebserver3)
}
