// MixAI Live engine on the phone (WP21-06, ADR-0015): cargo-ndk builds apps/live/engine/crates/live-ffi into
// jniLibs and UniFFI generates the Kotlin bindings (package ro.mixai.live.ffi) from the host library, same pattern
// as :listen-core / :decks-core. JVM unit tests load the HOST build of the same library (jna.library.path) and drive
// it through the real :live-core WebSocket client on the simulated "Null" loopback device.
// Toggle the Rust build with -Pmixai.buildRust=false (bindings + jniLibs must then already exist).
import org.gradle.api.tasks.Exec
import org.gradle.internal.os.OperatingSystem

plugins {
    alias(libs.plugins.android.library)
}

val repoRoot = rootProject.projectDir.resolve("../..").canonicalFile
val workspace = repoRoot.resolve("apps/live/engine")
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
    os.isWindows -> "live_ffi.dll"
    os.isMacOsX -> "liblive_ffi.dylib"
    else -> "liblive_ffi.so"
}
val hostLibFile = targetDir.resolve("debug/$hostLibName")
val rustSources = fileTree(workspace) {
    include("crates/**/*.rs", "crates/**/Cargo.toml", "crates/**/assets/**", "Cargo.toml", "Cargo.lock")
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
    namespace = "ro.mixai.live.ffi"
    compileSdk = libs.versions.compileSdk.get().toInt()
    ndkVersion = ndkVer
    defaultConfig {
        // AAudio needs API 26 (cpal's AAudio host); same floor as :live.
        minSdk = libs.versions.minSdk.get().toInt()
        consumerProguardFiles("consumer-rules.pro")
    }
    buildTypes {
        release { isMinifyEnabled = false }
        create("benchmark") { initWith(getByName("release")) }
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
    testOptions {
        unitTests.isReturnDefaultValues = true
        unitTests.all {
            it.systemProperty("jna.library.path", hostLibFile.parentFile.absolutePath)
            it.dependsOn("cargoBuildHostFfi")
            it.inputs.file(hostLibFile)
        }
    }
}

dependencies {
    api(project(":live-core"))
    implementation(libs.jna) { artifact { type = "aar" } }
    testImplementation(libs.junit)
    testImplementation(libs.jna)
}

fun cargoNdk(name: String, release: Boolean) = tasks.register<Exec>(name) {
    group = "rust"
    description = "cargo ndk build of live-ffi (${if (release) "release" else "debug"})"
    enabled = buildRust
    workingDir = workspace
    ndkEnv()
    val targets = abis(release).flatMap { listOf("-t", it) }
    commandLine(
        listOf("cargo", "ndk", "-o", jniOut.get().asFile.absolutePath, "--platform", "26") + targets +
            listOf("build", "-p", "live-ffi") + (if (release) listOf("--release") else emptyList()),
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
    commandLine("cargo", "build", "-p", "live-ffi", "--features", "cli")
    inputs.files(rustSources)
    outputs.file(hostLibFile)
}

val uniffiBindgen = tasks.register<Exec>("uniffiBindgen") {
    group = "rust"
    description = "Generate Kotlin bindings for live-ffi"
    enabled = buildRust
    dependsOn(hostLib)
    // Library-mode bindgen runs `cargo metadata` in the cwd to find uniffi.toml -> workspace root.
    workingDir = workspace
    commandLine(
        "cargo", "run", "-p", "live-ffi", "--features", "cli", "--bin", "uniffi-bindgen", "--",
        "generate", "--library", hostLibFile.absolutePath, "--language", "kotlin",
        "--out-dir", bindingsOut.get().asFile.absolutePath, "--no-format",
    )
    inputs.file(hostLibFile)
    outputs.dir(bindingsOut)
}

// Debug and release share the jniLibs dir: wire each variant's merge task to its own cargo task.
tasks.matching { it.name == "mergeDebugJniLibFolders" }.configureEach { dependsOn(cargoNdkDebug) }
tasks.matching { it.name == "mergeReleaseJniLibFolders" || it.name == "mergeBenchmarkJniLibFolders" }
    .configureEach { dependsOn(cargoNdkRelease) }
tasks.matching {
    (it.name.startsWith("compile") && it.name.contains("Kotlin")) ||
        (it.name.startsWith("extract") && it.name.endsWith("Annotations"))
}.configureEach { dependsOn(uniffiBindgen) }
