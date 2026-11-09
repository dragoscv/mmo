// MixAI Decks for Android (WP19-16, ADR-0014 D61): phone / tablet / ChromeOS DJ app on the Rust
// Decks core (`:decks-core` = decks-ffi over UniFFI + JNA) with the shared Compose Multiplatform UI
// (`:decks-ui`, also used by `:decks-desktop`). Built by the apps/tv-android Gradle build as `:decks`.
// AGP 9 ships built-in Kotlin.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "ro.mixai.dj"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "ro.mixai.dj"
        minSdk = 29
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
