// MixAI Decks shared UI (WP19-16/17, ADR-0014 D61): one Compose Multiplatform module for Android
// (:decks, phone/tablet/ChromeOS) and Desktop (:decks-desktop, Windows + Linux).
//  - commonMain: state, controller, pure logic (formatting, MIDI action dispatch), all screens/controls.
//  - jvmShared (src dir added to androidMain + desktopMain): the UniFFI engine adapter (ro.mixai.decks.ffi
//    over JNA — the JNA artefact differs per target: aar on Android, jar on desktop).
//  - androidMain / desktopMain: waveform surface, MIDI transport, folder picker, reduced motion.
// Colours come from the generated design tokens (Tokens.kt of :mobile-common), mirrored by `syncTokens`.
// KGP is on the root buildscript classpath and AGP's KMP plugin ships in the AGP jar: ids without versions.
plugins {
    id("com.android.kotlin.multiplatform.library")
    id("org.jetbrains.kotlin.multiplatform")
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.jetbrains.compose)
}

val repoRoot = rootProject.projectDir.resolve("../..").canonicalFile
val tokensDir = repoRoot.resolve("apps/mobile-android-common/src/main/java/ro/mixai/mobile/theme")
val tokensOut = layout.buildDirectory.dir("generated/tokens/kotlin")

// Mirror of the generated design tokens (single source: packages/design-tokens): Tokens.kt (sRGB) and
// TokenRoles.kt (OKLCH roles + dimensions for runtime skins, WP19-18). Never edited here.
val syncTokens = tasks.register<Sync>("syncTokens") {
    from(tokensDir) { include("Tokens.kt", "TokenRoles.kt") }
    into(tokensOut.map { it.dir("ro/mixai/mobile/theme") })
}
// Source dir carrying the task dependency (Kotlin compile tasks then depend on syncTokens implicitly).
val tokensSrcDir = files(tokensOut).builtBy(syncTokens)
val bindingsSrcDir = files(project(":decks-core").layout.buildDirectory.dir("generated/uniffi/kotlin"))
    .builtBy(":decks-core:uniffiBindgen")

kotlin {
    @Suppress("DEPRECATION")
    androidLibrary {
        namespace = "ro.mixai.decks.ui"
        compileSdk = libs.versions.compileSdk.get().toInt()
        minSdk = 29
        compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
        withHostTest {}
    }
    jvm("desktop") {
        compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
    }

    sourceSets {
        commonMain {
            kotlin.srcDir(tokensSrcDir)
            dependencies {
                implementation(libs.cmp.runtime)
                implementation(libs.cmp.foundation)
                implementation(libs.cmp.ui)
                implementation(libs.kotlinx.coroutines.core)
            }
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
        androidMain {
            kotlin.srcDir("src/jvmShared/kotlin")
            dependencies {
                api(project(":decks-core"))
                implementation(libs.kotlinx.serialization.json)
                implementation(libs.kotlinx.coroutines.android)
                implementation(libs.androidx.activity.compose)
            }
        }
        val desktopMain by getting {
            kotlin.srcDir("src/jvmShared/kotlin")
            kotlin.srcDir(bindingsSrcDir)
            dependencies {
                implementation(libs.jna)
                implementation(libs.kotlinx.serialization.json)
                implementation(libs.kotlinx.coroutines.swing)
                implementation(compose.desktop.common)
            }
        }
        val desktopTest by getting {
            dependencies {
                implementation(compose.desktop.currentOs)
            }
        }
    }
}

tasks.matching { it.name.startsWith("compile") || it.name.endsWith("SourcesJar") || it.name.startsWith("extract") }
    .configureEach { dependsOn(syncTokens) }

tasks.withType<Test>().configureEach {
    // Android string parity test reads the app's res/values*.
    systemProperty("decks.appRes", repoRoot.resolve("apps/decks-android/app/src/main/res").absolutePath)
}
