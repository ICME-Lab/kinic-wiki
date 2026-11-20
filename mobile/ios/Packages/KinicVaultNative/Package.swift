// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "KinicVaultNative",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "KinicVaultNative", targets: ["KinicVaultNative"])],
    dependencies: [.package(path: "../KinicVaultCore"), .package(url: "https://github.com/humandebri/ICNativeClient", exact: "0.8.0")],
    targets: [
        .binaryTarget(name: "CVaultVetKeys", path: "Artifacts/KinicVetKeys.xcframework"),
        .target(name: "KinicVaultNative", dependencies: ["KinicVaultCore", "CVaultVetKeys", .product(name: "ICNativeClient", package: "ICNativeClient")]),
        .testTarget(name: "KinicVaultNativeTests", dependencies: ["KinicVaultNative"]),
    ]
)
