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
