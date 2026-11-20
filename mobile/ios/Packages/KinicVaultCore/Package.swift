// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KinicVaultCore",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(
            name: "KinicVaultCore",
            targets: ["KinicVaultCore"]
        ),
    ],
    targets: [
        .target(
            name: "KinicVaultCore"
        ),
        .testTarget(
            name: "KinicVaultCoreTests",
            dependencies: ["KinicVaultCore"]
        ),
    ]
)
