// Shared Android data layer (WP16-49): MMO Server / mixai.ro API client, repositories, generated
// OpenAPI models, settings store, hub client and the background MusicService. Used by `:app`
// (Google TV) and the phone app. Packages stay `ro.mixai.tv.*` so no call site changed; the
// namespace differs from the app because android.nonTransitiveRClass is on. No resources, no R.
// AGP 9 ships built-in Kotlin: no `org.jetbrains.kotlin.android` plugin, no kotlinOptions.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "ro.mixai.core"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        minSdk = libs.versions.minSdk.get().toInt()
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
        // Mirrors the app's `benchmark` build type so its variant resolves without fallbacks.
        create("benchmark") {
            initWith(getByName("release"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.android)
    api(libs.okhttp)
    api(libs.datastore.preferences)
    api(libs.androidx.core.ktx)
    api(libs.media3.exoplayer)
    api(libs.media3.exoplayer.hls)
    api(libs.media3.session)
    api(libs.bundles.coil)

    testImplementation(libs.junit)
}
