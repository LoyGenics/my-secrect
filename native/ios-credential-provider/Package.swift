// swift-tools-version: 5.9
//
// Test harness for the Credential Provider's shared core. The extension
// target in the generated Xcode project (see
// apps/mobile/plugins/with-ios-credential-provider.js) compiles the SAME
// files in Sources/AutoFillCore/ plus Extension/*.swift, and links the
// same two packages at the same pinned versions. Keep the pins in sync
// with the plugin's SWIFT_PACKAGES table.
import PackageDescription

let package = Package(
    name: "AutoFillCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "AutoFillCore", targets: ["AutoFillCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/jedisct1/swift-sodium.git", exact: "0.11.0"),
        .package(url: "https://github.com/sqlcipher/SQLCipher.swift.git", exact: "4.20.0"),
    ],
    targets: [
        .target(
            name: "AutoFillCore",
            dependencies: [
                .product(name: "Clibsodium", package: "swift-sodium"),
                .product(name: "SQLCipher", package: "SQLCipher.swift"),
            ],
            path: "Sources/AutoFillCore"
        ),
        .testTarget(
            name: "AutoFillCoreTests",
            dependencies: [
                "AutoFillCore",
                .product(name: "Clibsodium", package: "swift-sodium"),
                .product(name: "SQLCipher", package: "SQLCipher.swift"),
            ],
            path: "tests/AutoFillCoreTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
