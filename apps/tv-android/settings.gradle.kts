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
