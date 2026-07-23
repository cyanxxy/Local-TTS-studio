# Desktop release process

Tagged releases are built natively by `.github/workflows/release-desktop.yml`. The workflow creates a draft GitHub Release, builds an unsigned macOS package, verifies the packaged native bridge, uploads the artifacts, and publishes after the macOS job succeeds.

Before a release ever runs, `.github/workflows/ci.yml` validates pushes to `main` and pull requests (lint, Electron type check, Vitest without the native-bridge integration test, web build), and `.github/workflows/rust-bridge.yml` builds, tests, and probes the native bridge on macOS arm64 whenever Rust sources or the bridge build scripts change. The release workflow's own `verify` job runs the full JS suite, including the native-bridge integration test.

## Release outputs

- macOS 26+ Apple Silicon: unsigned DMG and ZIP.

Windows remains available as a custom build target but is not attached to GitHub Releases.

## Signing status

Current release artifacts are intentionally unsigned and unnotarized. Users may need to Control-click **Open** and approve the first launch in macOS security settings. No signing secrets are required by the workflow.

Signing and notarization should be restored before presenting the download as a trusted Gatekeeper-ready distribution.

## Cut a release

1. Set the same semantic version in `package.json` and `package-lock.json`.
2. Run `npm run lint`, `npm run test`, and `npm run build`.
3. Commit every release input, including `rust/vendor/`; CI cannot build an untracked path dependency.
4. Create and push an annotated `vMAJOR.MINOR.PATCH` tag.
5. Watch **Release desktop installers**. A draft remains unpublished if the macOS package fails verification.

The macOS job sets `MACOSX_DEPLOYMENT_TARGET=26.0`, builds on an Apple Silicon macOS 26 runner, disables signing discovery, rejects Homebrew paths and newer deployment targets, and probes the packaged bridge before publishing.
