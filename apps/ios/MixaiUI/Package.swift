// swift-tools-version: 6.0
import PackageDescription

// Shared SwiftUI layer of the iPhone apps (WP17-42, D51): theme, components, connect + profile views, and the music
// stack (AVAudioEngine engine with crossfade / loudness normalisation, player, views, offline downloads). Used by
// MixAI (ro.mixai.app) and MixAI Music (ro.mixai.music). Localised strings resolve against the HOST app's catalog
// (`MixAI/Localizable.xcstrings`, compiled into both apps), so views use plain `Text("key")`.
let package = Package(
    name: "MixaiUI",
    platforms: [.iOS("26.0")],
    products: [
        .library(name: "MixaiUI", targets: ["MixaiUI"]),
    ],
    dependencies: [
        .package(path: "../MixaiCore"),
        // MIT, AVAudioEngine streaming player (FLAC/MP3/AAC/WAV over HTTP + local files, gapless queue, custom nodes).
        .package(url: "https://github.com/dimitris-c/AudioStreaming.git", exact: "1.4.5"),
    ],
    targets: [
        .target(
            name: "MixaiUI",
            dependencies: [
                .product(name: "MixaiCore", package: "MixaiCore"),
                .product(name: "AudioStreaming", package: "AudioStreaming"),
            ],
            path: "Sources/MixaiUI"
        ),
    ],
    swiftLanguageModes: [.v6]
)
