// MixAI Decks native core for Android (WP19-16, ADR-0014 D61): cargo-ndk builds
// apps/mixai/src-tauri/crates/decks-ffi into jniLibs and UniFFI generates the Kotlin bindings
// (package ro.mixai.decks.ffi) from the host library — same pattern as :listen-core (WP18-02).
// Toggle the Rust build with -Pmixai.buildRust=false (bindings + jniLibs must then already exist).
import org.gradle.api.tasks.Exec
import org.gradle.internal.os.OperatingSystem

plugins {
    alias(libs.plugins.android.library)
}

val repoRoot = rootProject.projectDir.resolve("../..").canonicalFile
// -Pmixai.decksWorkspace=<dir> builds decks-ffi from another checkout of apps/mixai/src-tauri (e.g. a HEAD snapshot).
val workspace = providers.gradleProperty("mixai.decksWorkspace").map { File(it) }
    .getOrElse(repoRoot.resolve("apps/mixai/src-tauri"))
val targetDir = System.getenv("CARGO_TARGET_DIR")?.let(::File) ?: workspace.resolve("target")
val jniOut = layout.buildDirectory.dir("rustJniLibs")
val bindingsOut = layout.buildDirectory.dir("generated/uniffi/kotlin")
val buildRust = providers.gradleProperty("mixai.buildRust").getOrElse("true").toBoolean()
val ndkVer = "28.2.13676358"

fun abis(release: Boolean): List<String> =
    providers.gradleProperty(if (release) "mixai.rustAbis.release" else "mixai.rustAbis.debug")
        .getOrElse("arm64-v8a,x86_64")
        .split(',').map { it.trim() }.filter { it.isNotEmpty() }

val os: OperatingSystem = OperatingSystem.current()
val hostLibName = when {
    os.isWindows -> "decks_ffi.dll"
    os.isMacOsX -> "libdecks_ffi.dylib"
    else -> "libdecks_ffi.so"
}
val hostLibFile = targetDir.resolve("debug/$hostLibName")
val rustSources = fileTree(workspace) {
    include("crates/**/*.rs", "crates/**/Cargo.toml", "crates/**/*.wgsl", "Cargo.toml", "Cargo.lock")
    exclude("target/**")
}

fun Exec.ndkEnv() {
    val sdk = System.getenv("ANDROID_HOME") ?: System.getenv("ANDROID_SDK_ROOT")
        ?: rootProject.file("local.properties").takeIf { it.exists() }?.readLines()
            ?.firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("=")?.replace("\\:", ":")?.replace("\\\\", "\\")
        ?: error("ANDROID_HOME not set and no local.properties sdk.dir")
    environment("ANDROID_NDK_HOME", File(sdk, "ndk/$ndkVer").absolutePath)
}

android {
    namespace = "ro.mixai.decks.core"
    compileSdk = libs.versions.compileSdk.get().toInt()
    ndkVersion = ndkVer
    defaultConfig {
        minSdk = 29
        consumerProguardFiles("consumer-rules.pro")
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets {
        getByName("main") {
            jniLibs.directories.add(jniOut.get().asFile.absolutePath)
            kotlin.directories.add(bindingsOut.get().asFile.absolutePath)
        }
    }
}

dependencies {
    api(libs.jna) { artifact { type = "aar" } }
}

fun cargoNdk(name: String, release: Boolean) = tasks.register<Exec>(name) {
    group = "rust"
    description = "cargo ndk build of decks-ffi (${if (release) "release" else "debug"})"
    enabled = buildRust
    workingDir = workspace
    ndkEnv()
    val targets = abis(release).flatMap { listOf("-t", it) }
    commandLine(
        listOf("cargo", "ndk", "-o", jniOut.get().asFile.absolutePath, "--platform", "29", "--link-libcxx-shared") +
            targets + listOf("build", "-p", "decks-ffi") + (if (release) listOf("--release") else emptyList()),
    )
    inputs.files(rustSources)
    inputs.property("abis", targets)
    outputs.dir(jniOut)
}

val cargoNdkDebug = cargoNdk("cargoNdkDebug", release = false)
val cargoNdkRelease = cargoNdk("cargoNdkRelease", release = true)

val hostLib = tasks.register<Exec>("cargoBuildHostFfi") {
    group = "rust"
    enabled = buildRust
    workingDir = workspace
    commandLine("cargo", "build", "-p", "decks-ffi", "--features", "cli")
    inputs.files(rustSources)
    outputs.file(hostLibFile)
}

val uniffiBindgen = tasks.register<Exec>("uniffiBindgen") {
    group = "rust"
    description = "Generate Kotlin bindings for decks-ffi"
    enabled = buildRust
    dependsOn(hostLib)
    // Library-mode bindgen runs `cargo metadata` in the cwd to find uniffi.toml -> workspace root.
    workingDir = workspace
    commandLine(
        "cargo", "run", "-p", "decks-ffi", "--features", "cli", "--bin", "uniffi-bindgen", "--",
        "generate", "--library", hostLibFile.absolutePath, "--language", "kotlin",
        "--out-dir", bindingsOut.get().asFile.absolutePath, "--no-format",
    )
    inputs.file(hostLibFile)
    outputs.dir(bindingsOut)
}

tasks.matching { it.name == "mergeDebugJniLibFolders" }.configureEach { dependsOn(cargoNdkDebug) }
tasks.matching { it.name == "mergeReleaseJniLibFolders" }.configureEach { dependsOn(cargoNdkRelease) }
tasks.matching {
    (it.name.startsWith("compile") && it.name.contains("Kotlin")) ||
        (it.name.startsWith("extract") && it.name.endsWith("Annotations"))
}.configureEach { dependsOn(uniffiBindgen) }
