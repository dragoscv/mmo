import java.util.Base64

// MixAI Decks for Android (WP19-16, ADR-0014 D61): phone / tablet / ChromeOS DJ app on the Rust
// Decks core (`:decks-core` = decks-ffi over UniFFI + JNA) with the shared Compose Multiplatform UI
// (`:decks-ui`, also used by `:decks-desktop`). Built by the apps/tv-android Gradle build as `:decks`.
// AGP 9 ships built-in Kotlin.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// Release signing from CI secrets (DECKS_KEYSTORE_B64 / _PASSWORD / DECKS_KEY_ALIAS / DECKS_KEY_PASSWORD), WP19-24.
// Without them `bundleRelease` produces an unsigned AAB (Play App Signing re-signs uploads with the app key).
val keystoreB64: String? = System.getenv("DECKS_KEYSTORE_B64")
val hasReleaseKeystore = !keystoreB64.isNullOrBlank()
val releaseKeystoreFile = layout.buildDirectory.file("decks-release.jks").get().asFile
if (hasReleaseKeystore && !releaseKeystoreFile.exists()) {
    releaseKeystoreFile.parentFile.mkdirs()
    releaseKeystoreFile.writeBytes(Base64.getDecoder().decode(keystoreB64))
}

android {
    namespace = "ro.mixai.dj"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "ro.mixai.dj"
        minSdk = 29
        targetSdk = libs.versions.targetSdk.get().toInt()
        // 2.0.0 = native Decks replacing the Tauri 1.x line in the same listings (ADR-0014 D62).
        versionCode = 2
        versionName = "2.0.0"
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = releaseKeystoreFile
                storePassword = System.getenv("DECKS_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("DECKS_KEY_ALIAS")
                keyPassword = System.getenv("DECKS_KEY_PASSWORD")
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
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "META-INF/versions/9/OSGI-INF/MANIFEST.MF")
        jniLibs.useLegacyPackaging = false
    }
}

dependencies {
    implementation(project(":decks-ui"))
    implementation(project(":decks-core"))
    implementation(libs.jna) { artifact { type = "aar" } }

    implementation(libs.cmp.runtime)
    implementation(libs.cmp.foundation)
    implementation(libs.cmp.ui)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
}
