import java.util.Base64

// MixAI phone app (WP16-46, D34/D36). Built by the apps/tv-android Gradle build (settings.gradle.kts
// includes it as `:phone`) so it shares `:core` (API client, repositories, generated models,
// MusicService) and the version catalog. AGP 9 ships built-in Kotlin: no kotlin.android plugin.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing from CI secrets (PHONE_KEYSTORE_B64 / PHONE_KEYSTORE_PASSWORD /
// PHONE_KEY_ALIAS / PHONE_KEY_PASSWORD). When absent the release build is unsigned.
val keystoreB64: String? = System.getenv("PHONE_KEYSTORE_B64")
val hasReleaseKeystore = !keystoreB64.isNullOrBlank()
val releaseKeystoreFile = layout.buildDirectory.file("phone-release.jks").get().asFile
if (hasReleaseKeystore && !releaseKeystoreFile.exists()) {
    releaseKeystoreFile.parentFile.mkdirs()
    releaseKeystoreFile.writeBytes(Base64.getDecoder().decode(keystoreB64))
}

// MixAI web origin for the account device-code flow. Override: -PmixaiOrigin=http://192.168.100.61:13789
val mixaiOrigin: String = (project.findProperty("mixaiOrigin") as String?)?.trim()?.trimEnd('/')
    ?.takeIf { it.isNotEmpty() } ?: "https://mixai.ro"

android {
    namespace = "ro.mixai.app"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "ro.mixai.app"
        minSdk = 31
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "MIXAI_ORIGIN", "\"$mixaiOrigin\"")
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = releaseKeystoreFile
                storePassword = System.getenv("PHONE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("PHONE_KEY_ALIAS")
                keyPassword = System.getenv("PHONE_KEY_PASSWORD")
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
        // Release code (R8, not debuggable) signed with the debug key — on-device perf measurements only.
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

    implementation(platform(libs.compose.bom))
    implementation(libs.bundles.compose)
    implementation(libs.compose.material3.adaptive.navigation.suite)
    implementation(libs.compose.material.icons.core)
    implementation(libs.compose.material.icons.extended)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.bundles.lifecycle)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.browser)

    implementation(libs.navigation3.runtime)
    implementation(libs.navigation3.ui)

    implementation(libs.bundles.media3)
    implementation(libs.media3.ui.compose)

    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.bundles.coil)
    implementation(libs.zxing.core)

    testImplementation(libs.junit)
}
