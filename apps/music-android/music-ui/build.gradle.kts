// Shared music UI (WP17-41, D50): library / album / artist / now-playing screens used by the phone
// app (`:phone`) and MixAI Music (`:music`). Host coupling goes through MusicDeps / MusicNav only.
// AGP 9 ships built-in Kotlin: no kotlin.android plugin.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "ro.mixai.music.ui"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        minSdk = 31
    }

    buildTypes {
        release { isMinifyEnabled = false }
        create("benchmark") { initWith(getByName("release")) }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
}

dependencies {
    api(project(":core"))

    api(platform(libs.compose.bom))
    api(libs.bundles.compose)
    implementation(libs.compose.material.icons.core)
    implementation(libs.compose.material.icons.extended)
    implementation(libs.androidx.activity.compose)

    testImplementation(libs.junit)
}
