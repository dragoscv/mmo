import java.util.Base64

// MixAI Key & BPM for Android (WP18-03, D58/D69): live key, BPM, Camelot wheel, tuner from the microphone, analysed
// on device by the Rust engine (`:listen-core` = crates/mixai-listen-ffi over UniFFI). Works offline with no account;
// the optional MMO Server connection (from `:mobile-common`) adds "mix next from my library" later.
// Built by the apps/tv-android Gradle build as `:keybpm`. AGP 9 ships built-in Kotlin.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing from CI secrets (KEYBPM_KEYSTORE_B64 / _PASSWORD / KEYBPM_KEY_ALIAS / KEYBPM_KEY_PASSWORD).
val keystoreB64: String? = System.getenv("KEYBPM_KEYSTORE_B64")
val hasReleaseKeystore = !keystoreB64.isNullOrBlank()
val releaseKeystoreFile = layout.buildDirectory.file("keybpm-release.jks").get().asFile
if (hasReleaseKeystore && !releaseKeystoreFile.exists()) {
    releaseKeystoreFile.parentFile.mkdirs()
    releaseKeystoreFile.writeBytes(Base64.getDecoder().decode(keystoreB64))
}

// Song ID (WP18-06): Apple's ShazamKit AAR is not redistributable, so it is never committed (public repo). It lives in
// gs://mmo-mw-prod_cloudbuild/vendor/shazamkit/<ver>/ and is fetched into app/libs/ by
// apps/keybpm-android/scripts/fetch-shazamkit.ps1. Without it the build uses src/noshazam (Song ID hidden).
val shazamAar = file(providers.gradleProperty("keybpm.shazamAar").orNull ?: "libs/shazamkit-android-release.aar")
val hasShazam = shazamAar.exists()
val shazamTokenUrl = providers.gradleProperty("keybpm.shazamTokenUrl").orNull ?: "https://mixai.ro/api/shazam/token"

android {
    namespace = "ro.mixai.keybpm"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "ro.mixai.keybpm"
        minSdk = 31
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 4
        versionName = "0.4.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "SHAZAM_TOKEN_URL", "\"$shazamTokenUrl\"")
        buildConfigField("boolean", "HAS_SHAZAM", hasShazam.toString())
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
        // UniFFI loads the engine with JNA; keep native libs uncompressed + 16 KB aligned (AGP default).
        jniLibs.useLegacyPackaging = false
    }
    sourceSets {
        getByName("main") {
            kotlin.directories.add(if (hasShazam) "src/shazam/kotlin" else "src/noshazam/kotlin")
        }
    }
}

dependencies {
    implementation(project(":listen-core"))
    implementation(project(":mobile-common"))
    implementation(libs.jna) { artifact { type = "aar" } }

    implementation(platform(libs.compose.bom))
    implementation(libs.bundles.compose)
    implementation(libs.compose.material.icons.core)
    implementation(libs.compose.material.icons.extended)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.bundles.lifecycle)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
    if (hasShazam) {
        implementation(files(shazamAar))
        implementation(libs.retrofit)
        implementation(libs.retrofit.converter.gson)
    }
    // Watch mirror (WP18-04): Wearable Data Layer to :keybpm-wear.
    implementation(libs.play.services.wearable)
    implementation(libs.kotlinx.coroutines.play.services)

    testImplementation(libs.junit)
}
