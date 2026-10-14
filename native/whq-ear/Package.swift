// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "whq-ear",
  platforms: [.macOS("26.0")],
  targets: [
    .executableTarget(
      name: "whq-ear",
      path: "Sources/whq-ear",
      exclude: ["Info.plist"],
      linkerSettings: [
        // Embed an Info.plist so TCC shows a reason for the mic + system audio prompts.
        .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
                      "-Xlinker", "Sources/whq-ear/Info.plist"]),
      ]
    ),
  ]
)
