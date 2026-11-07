// Shared mobile code (WP17-41, D52): brand theme + generated tokens + fonts, loading/empty/error
// states, QR, server connect (discovery / Quick Connect / manual), MixAI account sign-in (device
// code + native Google) and the Keystore session vault. Used by `:phone` and `:music`.
// Per-app values come in through MobileConfig. AGP 9 ships built-in Kotlin.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "ro.mixai.mobile"
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
    api(libs.compose.material.icons.core)
    implementation(libs.compose.material.icons.extended)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.browser)
    implementation(libs.credentials)
    implementation(libs.credentials.play.services.auth)
    implementation(libs.googleid)
    implementation(libs.zxing.core)

    testImplementation(libs.junit)
}
