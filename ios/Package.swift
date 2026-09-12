// swift-tools-version: 5.9
import PackageDescription

// The shared decoding and URL rules can be tested without a phone or signing team.
let package = Package(
    name: "ResetObservatoryCore",
    platforms: [.macOS(.v13), .iOS(.v17)],
    targets: [
        .target(name: "ResetCore", path: "ResetObservatory/Core"),
        .testTarget(name: "ResetCoreTests", dependencies: ["ResetCore"], path: "Tests")
    ]
)
