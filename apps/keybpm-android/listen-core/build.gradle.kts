// mixai-listen for Android (WP18-02): cargo-ndk builds crates/mixai-listen-ffi into jniLibs and UniFFI
// generates the Kotlin bindings from the host library (proc-macro metadata, no UDL). Consumed by :keybpm and
// :keybpm-wear. Toggle the Rust build with -Pmixai.buildRust=false (bindings + jniLibs must then already exist).
import org.gradle.api.tasks.Exec
import org.gradle.internal.os.OperatingSystem

plugins {
    alias(libs.plugins.android.library)
}

val repoRoot = rootProject.projectDir.resolve("../..").canonicalFile
val crates = repoRoot.resolve("crates")
val jniOut = layout.buildDirectory.dir("rustJniLibs")
val bindingsOut = layout.buildDirectory.dir("generated/uniffi/kotlin")
val buildRust = providers.gradleProperty("mixai.buildRust").getOrElse("true").toBoolean()
val ndkVer = "28.2.13676358"

fun abis(release: Boolean): List<String> =
    providers.gradleProperty(if (release) "mixai.rustAbis.release" else "mixai.rustAbis.debug")
        // Debug includes armeabi-v7a: the Galaxy Watch8 (:keybpm-wear test device) is 32-bit only.
        .getOrElse(if (release) "arm64-v8a,armeabi-v7a,x86_64" else "arm64-v8a,armeabi-v7a,x86_64")
        .split(',').map { it.trim() }.filter { it.isNotEmpty() }

val os: OperatingSystem = OperatingSystem.current()
val hostLibName = when {
    os.isWindows -> "mixai_listen_ffi.dll"
    os.isMacOsX -> "libmixai_listen_ffi.dylib"
    else -> "libmixai_listen_ffi.so"
}
val hostLibFile = crates.resolve("target/debug/$hostLibName")
val rustSources = fileTree(crates) {
    include("**/*.rs", "**/Cargo.toml", "Cargo.lock", "**/models/*.onnx")
    exclude("target/**", "**/train/**")
}

fun Exec.ndkEnv() {
    val sdk = System.getenv("ANDROID_HOME") ?: System.getenv("ANDROID_SDK_ROOT")
        ?: rootProject.file("local.properties").takeIf { it.exists() }?.readLines()
            ?.firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("=")?.replace("\\:", ":")?.replace("\\\\", "\\")
        ?: error("ANDROID_HOME not set and no local.properties sdk.dir")
    environment("ANDROID_NDK_HOME", File(sdk, "ndk/$ndkVer").absolutePath)
}

android {
    namespace = "ro.mixai.listen"
    compileSdk = libs.versions.compileSdk.get().toInt()
    ndkVersion = ndkVer
    defaultConfig {
        minSdk = 30
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
        unitTests.all {
            it.systemProperty("jna.library.path", hostLibFile.parentFile.absolutePath)
            it.dependsOn("cargoBuildHostFfi")
            it.inputs.file(hostLibFile)
        }
    }
}

dependencies {
    implementation(libs.jna) { artifact { type = "aar" } }
    testImplementation(libs.junit)
    testImplementation(libs.jna)
}

fun cargoNdk(name: String, release: Boolean) = tasks.register<Exec>(name) {
    group = "rust"
    description = "cargo ndk build of mixai-listen-ffi (${if (release) "release" else "debug"})"
    enabled = buildRust
    workingDir = crates
    ndkEnv()
    val targets = abis(release).flatMap { listOf("-t", it) }
    commandLine(
        listOf("cargo", "ndk", "-o", jniOut.get().asFile.absolutePath, "--platform", "30") + targets +
            listOf("build", "-p", "mixai-listen-ffi") + (if (release) listOf("--release") else emptyList()),
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
    workingDir = crates
    commandLine("cargo", "build", "-p", "mixai-listen-ffi", "--features", "cli")
    inputs.files(rustSources)
    outputs.file(hostLibFile)
}

val uniffiBindgen = tasks.register<Exec>("uniffiBindgen") {
    group = "rust"
    description = "Generate Kotlin bindings for mixai-listen-ffi"
    enabled = buildRust
    dependsOn(hostLib)
    workingDir = crates
    commandLine(
        "cargo", "run", "-p", "mixai-listen-ffi", "--features", "cli", "--bin", "uniffi-bindgen", "--",
        "generate", "--library", "target/debug/$hostLibName", "--language", "kotlin",
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
