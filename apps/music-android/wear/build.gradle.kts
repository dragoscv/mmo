// MixAI Music for Wear OS (WP17-41g, D50): standalone watch app. Same applicationId as the phone app
// (`ro.mixai.music`) so Play pairs them and the Wearable Data Layer can hand over the server connection;
// works without the phone (Quick Connect code on the watch, approve elsewhere). Shares :core (API,
// MusicService player, TrackDownloads) and :mobile-common (tokens). AGP 9 built-in Kotlin.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "ro.mixai.music.wear"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "ro.mixai.music"
        minSdk = 31
        targetSdk = libs.versions.targetSdk.get().toInt()
        // Wear builds get their own versionCode range (phone 1.., wear 100001..) so both live in one Play listing.
        versionCode = 100002
        versionName = "0.2.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
    implementation(project(":core"))
    implementation(project(":mobile-common"))

    implementation(platform(libs.compose.bom))
    implementation(libs.wear.compose.material3)
    implementation(libs.wear.compose.foundation)
    implementation(libs.wear.compose.navigation)
    implementation(libs.wear)
    implementation(libs.wear.input)
    implementation(libs.play.services.wearable)
    implementation(libs.compose.material.icons.extended)
    implementation(libs.androidx.activity.compose)
    implementation(libs.bundles.lifecycle)
    implementation(libs.media3.exoplayer.workmanager)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
}
