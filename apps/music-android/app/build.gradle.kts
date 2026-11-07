import java.util.Base64

// MixAI Music for Android (WP17-41, D50/D52): standalone music app `ro.mixai.music`. Built by the
// apps/tv-android Gradle build (settings.gradle.kts includes it as `:music`) so it shares `:core`
// (API, repositories, MusicService), `:mobile-common` (theme, connect, sign-in) and `:music-ui`.
// AGP 9 ships built-in Kotlin: no kotlin.android plugin.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing from CI secrets (MUSIC_KEYSTORE_B64 / MUSIC_KEYSTORE_PASSWORD / MUSIC_KEY_ALIAS /
// MUSIC_KEY_PASSWORD). When absent the release build is unsigned.
val keystoreB64: String? = System.getenv("MUSIC_KEYSTORE_B64")
val hasReleaseKeystore = !keystoreB64.isNullOrBlank()
val releaseKeystoreFile = layout.buildDirectory.file("music-release.jks").get().asFile
if (hasReleaseKeystore && !releaseKeystoreFile.exists()) {
    releaseKeystoreFile.parentFile.mkdirs()
    releaseKeystoreFile.writeBytes(Base64.getDecoder().decode(keystoreB64))
}

// Same origins as the phone app (device-code host, web for native Google sign-in). Override with -P.
val mixaiOrigin: String = (project.findProperty("mixaiOrigin") as String?)?.trim()?.trimEnd('/')
    ?.takeIf { it.isNotEmpty() } ?: "https://mixai.ro"
val mixaiWebOrigin: String = (project.findProperty("mixaiWebOrigin") as String?)?.trim()?.trimEnd('/')
    ?.takeIf { it.isNotEmpty() } ?: "https://mixai.ro"
val googleWebClientId: String = (project.findProperty("mixaiGoogleWebClientId") as String?)?.trim()?.takeIf { it.isNotEmpty() }
    ?: "622082681070-12mtrfam879ia4cc0mp8prcmslphs0vg.apps.googleusercontent.com"

android {
    namespace = "ro.mixai.music"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "ro.mixai.music"
        minSdk = 31
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "MIXAI_ORIGIN", "\"$mixaiOrigin\"")
        buildConfigField("String", "MIXAI_WEB_ORIGIN", "\"$mixaiWebOrigin\"")
        buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"$googleWebClientId\"")
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = releaseKeystoreFile
                storePassword = System.getenv("MUSIC_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("MUSIC_KEY_ALIAS")
                keyPassword = System.getenv("MUSIC_KEY_PASSWORD")
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
    implementation(project(":core"))
    implementation(project(":mobile-common"))
    implementation(project(":music-ui"))

    implementation(platform(libs.compose.bom))
    implementation(libs.bundles.compose)
    implementation(libs.compose.material3.adaptive.navigation.suite)
    implementation(libs.compose.material.icons.core)
    implementation(libs.compose.material.icons.extended)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.bundles.lifecycle)
    implementation(libs.androidx.core.splashscreen)

    implementation(libs.navigation3.runtime)
    implementation(libs.navigation3.ui)

    implementation(libs.bundles.media3)
    implementation(libs.datastore.preferences)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.bundles.coil)

    testImplementation(libs.junit)
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
}
