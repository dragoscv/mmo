import java.util.Base64

// MixAI phone app (WP16-46, D34/D36). Built by the apps/tv-android Gradle build (settings.gradle.kts
// includes it as `:phone`) so it shares `:core` (API client, repositories, generated models,
// MusicService) and the version catalog. AGP 9 ships built-in Kotlin: no kotlin.android plugin.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    // FCM (push): reads app/google-services.json (Firebase project mmo-mw-prod). Phone only.
    alias(libs.plugins.google.services)
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

// Web origin for push registration + native Google sign-in (`/api/push/register`, `/api/auth/native/google`).
// mixai.ro DNS is pending, so it defaults to the Cloud Run URL. Override: -PmixaiWebOrigin=https://mixai.ro
val mixaiWebOrigin: String = (project.findProperty("mixaiWebOrigin") as String?)?.trim()?.trimEnd('/')
    ?.takeIf { it.isNotEmpty() } ?: "https://mixai-web-622082681070.europe-west1.run.app"

// Google "web" OAuth client id the ID token is requested for (= apps/web AUTH_GOOGLE_ID; a public id, not a secret).
val googleWebClientId: String = (project.findProperty("mixaiGoogleWebClientId") as String?)?.trim()?.takeIf { it.isNotEmpty() }
    ?: "622082681070-12mtrfam879ia4cc0mp8prcmslphs0vg.apps.googleusercontent.com"

// Sentry DSN: gradle property or env MIXAI_SENTRY_DSN_PHONE. Empty = Sentry disabled (env-gated).
val sentryDsn: String = ((project.findProperty("MIXAI_SENTRY_DSN_PHONE") as String?) ?: System.getenv("MIXAI_SENTRY_DSN_PHONE") ?: "").trim()

android {
    namespace = "ro.mixai.app"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "ro.mixai.app"
        minSdk = 31
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 2
        versionName = "1.1.0"
        buildConfigField("String", "MIXAI_ORIGIN", "\"$mixaiOrigin\"")
        buildConfigField("String", "MIXAI_WEB_ORIGIN", "\"$mixaiWebOrigin\"")
        buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"$googleWebClientId\"")
        buildConfigField("String", "SENTRY_DSN", "\"$sentryDsn\"")
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
    implementation(libs.media3.cast)
    implementation(libs.media3.exoplayer.workmanager)
    implementation(libs.work.runtime.ktx)

    implementation(libs.credentials)
    implementation(libs.credentials.play.services.auth)
    implementation(libs.googleid)

    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.sentry.android)
    implementation(libs.datastore.preferences)

    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.bundles.coil)
    implementation(libs.zxing.core)

    testImplementation(libs.junit)
}
