import java.util.Base64

// MixAI Key & BPM for Wear OS (WP18-04, D58): live key + BPM from the watch microphone (same Rust engine as the
// phone via :listen-core), or mirrored from the phone app over the Wearable Data Layer while the phone listens;
// haptic beat, wrist tap tempo, tile + complication. Same applicationId and upload key as :keybpm so Play ships both
// in one listing and the Data Layer pairs them. AGP 9 built-in Kotlin.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// Release signing: same upload key as :keybpm (KEYBPM_KEYSTORE_B64 / _PASSWORD / KEYBPM_KEY_ALIAS / _KEY_PASSWORD).
val keystoreB64: String? = System.getenv("KEYBPM_KEYSTORE_B64")
val hasReleaseKeystore = !keystoreB64.isNullOrBlank()
val releaseKeystoreFile = layout.buildDirectory.file("keybpm-release.jks").get().asFile
if (hasReleaseKeystore && !releaseKeystoreFile.exists()) {
    releaseKeystoreFile.parentFile.mkdirs()
    releaseKeystoreFile.writeBytes(Base64.getDecoder().decode(keystoreB64))
}

android {
    namespace = "ro.mixai.keybpm.wear"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "ro.mixai.keybpm"
        minSdk = 31
        targetSdk = libs.versions.targetSdk.get().toInt()
        // Wear builds use their own versionCode range (phone 1.., wear 100001..) so both live in one Play listing.
        versionCode = 100002
        versionName = "0.4.0"
        // Play requires 64-bit for Wear (2026-09-15); armeabi-v7a stays for 32-bit watches (Galaxy Watch8).
        // -Pkeybpm.wearAbis=armeabi-v7a keeps device-test APKs small (Wi-Fi adb to the watch is slow).
        val abis = providers.gradleProperty("keybpm.wearAbis").orNull?.split(',') ?: listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        ndk { abiFilters += abis }
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = releaseKeystoreFile
                storePassword = System.getenv("KEYBPM_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEYBPM_KEY_ALIAS")
                keyPassword = System.getenv("KEYBPM_KEY_PASSWORD")
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
        jniLibs.useLegacyPackaging = false
    }
}

dependencies {
    implementation(project(":listen-core"))
    implementation(project(":mobile-common"))
    implementation(libs.jna) { artifact { type = "aar" } }

    implementation(platform(libs.compose.bom))
    implementation(libs.wear.compose.material3)
    implementation(libs.wear.compose.foundation)
    implementation(libs.wear.compose.navigation)
    implementation(libs.wear)
    implementation(libs.wear.ongoing)
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
