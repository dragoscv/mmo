// swift-tools-version: 6.0
// MixAI Live controller core (WP21-09, ADR-0015): protocol v1 models (docs/live/remote-protocol.md), a pure reducer,
// the WebSocket `LiveClient`, pairing links, paired-engine storage and the phone <-> watch link. No Rust / FFI:
// the iPhone, iPad and Apple Watch apps are pure clients of the engine's LAN control protocol.
import PackageDescription

let package = Package(
    name: "LiveCore",
    platforms: [
        .iOS("26.0"),
        .watchOS("11.0"),
        .macOS(.v15),
    ],
    products: [
        .library(name: "LiveCore", targets: ["LiveCore"]),
    ],
    targets: [
        .target(name: "LiveCore", path: "Sources/LiveCore"),
        .testTarget(name: "LiveCoreTests", dependencies: ["LiveCore"], path: "Tests/LiveCoreTests"),
    ],
    swiftLanguageModes: [.v6]
)
