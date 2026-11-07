pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "mixai-tv"
include(":app")
// Shared data layer (API client, repositories, models, MusicService) — reused by the phone app (WP16-49).
include(":core")
// Native phone app (WP16-46, D36): lives in apps/phone-android/app, built by this Gradle build to share :core.
include(":phone")
project(":phone").projectDir = file("../phone-android/app")
// MixAI Music (WP17-41, D50): shared music screens + the standalone music app, both on :core.
include(":mobile-common")
project(":mobile-common").projectDir = file("../mobile-android-common")
include(":music-ui")
project(":music-ui").projectDir = file("../music-android/music-ui")
include(":music")
project(":music").projectDir = file("../music-android/app")
// MixAI Music for Wear OS (WP17-41g, standalone; same applicationId as :music for Play pairing).
include(":wear")
project(":wear").projectDir = file("../music-android/wear")
