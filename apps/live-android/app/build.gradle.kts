import java.util.Base64

// MixAI Live controller for Android phones/tablets (WP21-08, ADR-0015): pairs with the MixAI Live engine by QR /
// link / mDNS and drives it over protocol v1 (WebSocket): meters, tuner, PANIC/MUTE/BYPASS, scenes + setlist with a
// lyrics teleprompter, mix sliders, presets, and (controller role) the insert chain. "Local engine" mode runs the
// same Rust engine on the phone (:live-ffi) and connects to it over 127.0.0.1.
// Built by the apps/tv-android Gradle build as `:live`. AGP 9 ships built-in Kotlin.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// Release signing from CI secrets (LIVE_KEYSTORE_B64 / _PASSWORD / LIVE_KEY_ALIAS / LIVE_KEY_PASSWORD).
val keystoreB64: String? = System.getenv("LIVE_KEYSTORE_B64")
val hasReleaseKeystore = !keystoreB64.isNullOrBlank()
val releaseKeystoreFile = layout.buildDirectory.file("live-release.jks").get().asFile
if (hasReleaseKeystore && !releaseKeystoreFile.exists()) {
    releaseKeystoreFile.parentFile.mkdirs()
    releaseKeystoreFile.writeBytes(Base64.getDecoder().decode(keystoreB64))
}

android {
    namespace = "ro.mixai.live"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "ro.mixai.live"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = releaseKeystoreFile
                storePassword = System.getenv("LIVE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("LIVE_KEY_ALIAS")
                keyPassword = System.getenv("LIVE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseKeystore) signingConfig = signingConfigs.getByName("release")
        }
        create("benchmark") {
            initWith(getByName("release"))
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
            isDebuggable = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }
}

dependencies {
    implementation(project(":live-core"))
    // The engine itself, for "Local engine" mode (phone as a backup processor, WP21-06).
    implementation(project(":live-ffi"))
    // Design tokens + fonts + Material 3 theme (MixaiTheme); the MMO data layer it re-exports is unused here.
    implementation(project(":mobile-common"))

    implementation(platform(libs.compose.bom))
    implementation(libs.bundles.compose)
    implementation(libs.compose.material.icons.core)
    implementation(libs.compose.material.icons.extended)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    // play-services-wearable pulls fragment 1.0; activity-result APIs need >= 1.3 (lint InvalidFragmentVersionForActivityResult).
    implementation(libs.androidx.fragment)
    implementation(libs.bundles.lifecycle)
    implementation(libs.kotlinx.coroutines.android)

    // QR pairing: CameraX preview + zxing core decoding (zxing is already used for QR rendering in this build).
    implementation(libs.camera.core)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.view)
    implementation(libs.zxing.core)

    // Hand the paired engine to :live-wear (DataClient /live/engine).
    implementation(libs.play.services.wearable)
    implementation(libs.kotlinx.coroutines.play.services)

    testImplementation(libs.junit)
}
