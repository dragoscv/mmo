// MixAI Decks for Windows + Linux (WP19-17, ADR-0014 D61): Compose Multiplatform Desktop on the
// shared `:decks-ui`. The host decks_ffi library (Rust, apps/mixai/src-tauri/crates/decks-ffi) is
// built by `cargoBuildDecksFfi` (`cargo build -p decks-ffi --release`) and bundled through
// compose.desktop appResources (resources dir → `compose.application.resources.dir` at runtime,
// where DesktopDecks.configureLibrary() points UniFFI/JNA at it).
// Packaging: MSI (Windows), DEB (Linux) via jpackage — needs a JDK with jpackage (JDK 17+ full JDK;
// set -Pdecks.jpackageJdk=<jdk dir> or run Gradle on such a JDK).
import org.gradle.internal.os.OperatingSystem
import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    id("org.jetbrains.kotlin.jvm")
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.jetbrains.compose)
}

val repoRoot = rootProject.projectDir.resolve("../..").canonicalFile
val workspace = providers.gradleProperty("mixai.decksWorkspace").map { File(it) }
    .getOrElse(repoRoot.resolve("apps/mixai/src-tauri"))
val targetDir = System.getenv("CARGO_TARGET_DIR")?.let(::File) ?: workspace.resolve("target")
val buildRust = providers.gradleProperty("mixai.buildRust").getOrElse("true").toBoolean()
val os: OperatingSystem = OperatingSystem.current()
val hostLibName = when {
    os.isWindows -> "decks_ffi.dll"
    os.isMacOsX -> "libdecks_ffi.dylib"
    else -> "libdecks_ffi.so"
}
val osDir = when {
    os.isWindows -> "windows"
    os.isMacOsX -> "macos"
    else -> "linux"
}
val hostLib = targetDir.resolve("release/$hostLibName")
val appResDir = layout.buildDirectory.dir("decksAppResources")

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

val cargoBuildDecksFfi = tasks.register<Exec>("cargoBuildDecksFfi") {
    group = "rust"
    description = "cargo build -p decks-ffi --release (host library for the desktop app)"
    enabled = buildRust
    workingDir = workspace
    commandLine("cargo", "build", "-p", "decks-ffi", "--release")
    inputs.files(fileTree(workspace) {
        include("crates/**/*.rs", "crates/**/Cargo.toml", "crates/**/*.wgsl", "Cargo.toml", "Cargo.lock")
        exclude("target/**")
    })
    outputs.file(hostLib)
}

// compose.desktop appResources layout: <dir>/common + <dir>/<os> (os = windows | linux | macos).
val stageNativeLib = tasks.register<Sync>("stageDecksFfi") {
    dependsOn(cargoBuildDecksFfi)
    from(hostLib)
    into(appResDir.map { it.dir(osDir) })
}

dependencies {
    implementation(project(":decks-ui"))
    implementation(compose.desktop.currentOs)
    implementation(libs.jna)
    implementation(libs.kotlinx.coroutines.swing)
}

compose.desktop {
    application {
        mainClass = "ro.mixai.decks.desktop.MainKt"
        jvmArgs += listOf("-Dsun.java2d.uiScale.enabled=true")
        providers.gradleProperty("decks.jpackageJdk").orNull?.let { javaHome = it }
        nativeDistributions {
            targetFormats(TargetFormat.Msi, TargetFormat.Deb)
            packageName = "MixAI Decks"
            packageVersion = "1.0.0"
            description = "MixAI Decks — DJ software"
            vendor = "MixAI"
            copyright = "© 2026 MixAI"
            appResourcesRootDir.set(appResDir)
            modules("java.desktop", "jdk.unsupported")
            windows {
                menuGroup = "MixAI"
                upgradeUuid = "6f2b7a3e-1c9d-4f58-9b0a-2d7e5c4a8b31"
                perUserInstall = true
                dirChooser = true
            }
            linux {
                packageName = "mixai-decks"
                debMaintainer = "support@mixai.ro"
                appCategory = "AudioVideo"
            }
        }
    }
}

// Every task that needs the bundled library (run, distributable, packages, prepareAppResources).
tasks.matching {
    it.name == "prepareAppResources" || it.name.startsWith("run") || it.name.startsWith("createDistributable") ||
        it.name.startsWith("package")
}.configureEach { dependsOn(stageNativeLib) }

// `run` without packaging: point JNA at the staged library directly.
tasks.withType<JavaExec>().configureEach {
    systemProperty("decks.ffi.path", appResDir.get().dir(osDir).file(hostLibName).asFile.absolutePath)
}
