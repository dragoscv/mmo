import java.util.Base64

// MixAI Live controller for Wear OS (WP21-08, ADR-0015): scene prev/next, MUTE/PANIC, current song/part, input level
// ring and tuner glance, plus a tile and a complication. The engine comes from the phone (DataClient /live/engine) or
// is reached directly over Wi-Fi with the same :live-core client. Same applicationId and upload key as :live so Play
// ships both in one listing. Companion-optional (standalone=false). AGP 9 built-in Kotlin.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

val keystoreB64: String? = System.getenv("LIVE_KEYSTORE_B64")
val hasReleaseKeystore = !keystoreB64.isNullOrBlank()
val releaseKeystoreFile = layout.buildDirectory.file("live-release.jks").get().asFile
if (hasReleaseKeystore && !releaseKeystoreFile.exists()) {
    releaseKeystoreFile.parentFile.mkdirs()
    releaseKeystoreFile.writeBytes(Base64.getDecoder().decode(keystoreB64))
}

android {
    namespace = "ro.mixai.live.wear"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "ro.mixai.live"
        minSdk = 30
        targetSdk = libs.versions.targetSdk.get().toInt()
        // Wear builds use their own versionCode range (phone 1.., wear 100001..) so both live in one Play listing.
        versionCode = 100001
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
    // Design tokens (Tokens.kt) for the Wear colour scheme; minSdk 31 there, overridden in the manifest (tokens only).
    implementation(project(":mobile-common"))

    implementation(platform(libs.compose.bom))
    implementation(libs.wear.compose.material3)
    implementation(libs.wear.compose.foundation)
    implementation(libs.wear)
    implementation(libs.wear.tiles)
    implementation(libs.protolayout)
    implementation(libs.protolayout.material3)
    implementation(libs.protolayout.expression)
    implementation(libs.wear.complications.data.source.ktx)
    implementation(libs.play.services.wearable)
    implementation(libs.kotlinx.coroutines.play.services)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.fragment)
    implementation(libs.bundles.lifecycle)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
}
