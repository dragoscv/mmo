import java.util.Base64

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing from CI secrets (TV_KEYSTORE_B64 / TV_KEYSTORE_PASSWORD /
// TV_KEY_ALIAS / TV_KEY_PASSWORD). When absent the release build is unsigned.
val keystoreB64: String? = System.getenv("TV_KEYSTORE_B64")
val hasReleaseKeystore = !keystoreB64.isNullOrBlank()
val releaseKeystoreFile = layout.buildDirectory.file("tv-release.jks").get().asFile
if (hasReleaseKeystore && !releaseKeystoreFile.exists()) {
    releaseKeystoreFile.parentFile.mkdirs()
    releaseKeystoreFile.writeBytes(Base64.getDecoder().decode(keystoreB64))
}

// MixAI web origin for the account device-code flow. Debug override:
//   gradlew assembleDebug -PmixaiOrigin=http://192.168.100.61:13789
val mixaiOrigin: String = (project.findProperty("mixaiOrigin") as String?)?.trim()?.trimEnd('/')
    ?.takeIf { it.isNotEmpty() } ?: "https://mixai.ro"

android {
    namespace = "ro.mixai.tv"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "ro.mixai.tv"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 3
        versionName = "1.1.0"
        buildConfigField("String", "MIXAI_ORIGIN", "\"$mixaiOrigin\"")
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = releaseKeystoreFile
                storePassword = System.getenv("TV_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TV_KEY_ALIAS")
                keyPassword = System.getenv("TV_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ""
        }
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
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.bundles.compose)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.bundles.lifecycle)

    // Compose for TV (tv-foundation is not imported anywhere → not a dependency)
    implementation(libs.tv.material)

    // Media3 (ExoPlayer + HLS + PlayerView + MediaSession for the remote's transport keys)
    implementation(libs.bundles.media3)

    implementation(libs.datastore.preferences)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.bundles.coil)

    // QR code for Quick Connect (BitMatrix only; drawn with Compose Canvas, no camera)
    implementation(libs.zxing.core)

    // Watch Next channel (WP12-01)
    implementation(libs.tvprovider)
}
