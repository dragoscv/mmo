// AGP 9 ships built-in Kotlin: no `org.jetbrains.kotlin.android` plugin. The KGP on the
// buildscript classpath pins the Kotlin version used by that built-in support.
buildscript {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
    dependencies { classpath(libs.kotlin.gradle.plugin) }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
