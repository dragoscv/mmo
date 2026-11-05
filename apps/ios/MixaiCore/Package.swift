// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MixaiCore",
    platforms: [
        .iOS("26.0"),
        .macOS(.v15),
    ],
    products: [
        .library(name: "MixaiCore", targets: ["MixaiCore"]),
    ],
    targets: [
        .target(
            name: "MixaiCore",
            path: "Sources/MixaiCore"
        ),
        .testTarget(
            name: "MixaiCoreTests",
            dependencies: ["MixaiCore"],
            path: "Tests/MixaiCoreTests",
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageModes: [.v6]
)
