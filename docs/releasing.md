# Desktop release process

Tagged releases are built natively by `.github/workflows/release-desktop.yml`. The workflow creates a draft GitHub Release, builds both platforms, verifies the packaged native bridges and signatures, uploads the installers, and publishes only after both jobs succeed.

## Release outputs

- macOS 26+ Apple Silicon: signed and notarized DMG and ZIP.
- Windows 10/11 x64: signed NSIS installer with LibTorch 2.7.0 CPU.

The Windows source can be built against CUDA-enabled LibTorch, but that runtime is not attached to GitHub Releases: the official CUDA 12.6 archive is already larger than GitHub's 2 GiB per-file release limit before packaging.

## Repository secrets

Configure these Actions secrets before pushing a version tag:

| Secret | Value |
|---|---|
| `MACOS_CSC_LINK` | Base64-encoded Developer ID Application `.p12` |
| `MACOS_CSC_KEY_PASSWORD` | Password for the `.p12` |
| `MACOS_API_KEY_BASE64` | Base64-encoded App Store Connect API `.p8` |
| `MACOS_API_KEY_ID` | App Store Connect API key ID |
| `MACOS_API_ISSUER` | App Store Connect API issuer ID |
| `WINDOWS_CSC_LINK` | Base64-encoded Windows code-signing `.pfx` |
| `WINDOWS_CSC_KEY_PASSWORD` | Password for the `.pfx` |

The workflow intentionally fails instead of publishing an unsigned or unnotarized installer.

## Cut a release

1. Set the same semantic version in `package.json` and `package-lock.json`.
2. Run `npm run lint`, `npm run test`, and `npm run build`.
3. Commit every release input, including `rust/vendor/`; CI cannot build an untracked path dependency.
4. Create and push an annotated `vMAJOR.MINOR.PATCH` tag.
5. Watch **Release desktop installers**. A draft remains unpublished if either platform fails.

The macOS job sets `MACOSX_DEPLOYMENT_TARGET=26.0`, builds on an Apple Silicon macOS 26 runner, rejects Homebrew paths and newer deployment targets, then verifies Developer ID signing and notarization. The Windows job downloads the pinned CPU LibTorch archive, forces Authenticode signing, removes build-only environment paths, and probes the packaged bridge using only system paths.
