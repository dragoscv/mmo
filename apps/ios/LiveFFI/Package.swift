// swift-tools-version: 6.0
// MixAI Live engine for Apple platforms (WP21-06, ADR-0015): the phone runs the same Rust engine as the desktop
// sidecar (apps/live/engine/crates/live-ffi, UniFFI 0.32) as a backup processor.
// LiveFFI.xcframework (static liblive_ffi.a + C header/module map) and Sources/LiveFFI/LiveFFI.swift are GENERATED
// by apps/ios/scripts/build-live-xcframework.sh and gitignored; only this manifest + the placeholder are committed.
// Without the generated xcframework the package declares no binary target, so the shared XcodeGen project still
// resolves for the other apps, and LiveApp compiles its "Local engine" UI behind `#if canImport(live_ffiFFI)`.
import Foundation
import PackageDescription

let hasBinary = FileManager.default.fileExists(atPath: Context.packageDirectory + "/LiveFFI.xcframework")

let package = Package(
    name: "LiveFFI",
    platforms: [
        .iOS("26.0"),
        .macOS(.v15),
    ],
    products: [
        .library(name: "LiveFFI", targets: ["LiveFFI"]),
    ],
    targets: [
        .target(
            name: "LiveFFI",
            dependencies: hasBinary ? ["live_ffiFFI"] : [],
            path: "Sources/LiveFFI",
            linkerSettings: [
                // Native deps of the Rust staticlib: cpal (CoreAudio / AVAudioSession), std networking.
                .linkedLibrary("c++"),
                .linkedLibrary("resolv"),
                .linkedLibrary("objc"),
                .linkedFramework("AVFAudio"),
                .linkedFramework("Foundation"),
                .linkedFramework("CoreFoundation"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("Security"),
                .linkedFramework("SystemConfiguration"),
                .linkedFramework("IOKit", .when(platforms: [.macOS])),
                .linkedFramework("AudioUnit", .when(platforms: [.macOS])),
                .linkedFramework("UIKit", .when(platforms: [.iOS])),
            ]
        ),
    ] + (hasBinary ? [.binaryTarget(name: "live_ffiFFI", path: "LiveFFI.xcframework")] : []),
    // UniFFI-generated Swift keeps a few process-wide globals; compile it in Swift 5 mode.
    swiftLanguageModes: [.v5]
)
