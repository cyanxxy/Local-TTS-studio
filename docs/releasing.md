# Release process

Open TTS publishes source-only GitHub Releases. The repository does not publish
unsigned DMG, ZIP app bundles, or Windows installers.

`.github/workflows/release-desktop.yml` runs on every push to `main`. It compares
the semantic version in `package.json` with existing tags. When that version has
not been released, the workflow runs the full source-release checks, creates an
annotated `vMAJOR.MINOR.PATCH` tag on the verified `main` commit, and publishes a
GitHub Release using `docs/releases/vMAJOR.MINOR.PATCH.md`. GitHub supplies the
standard source ZIP and tarball archives.

The same workflow also verifies a manually pushed version tag, provided the tag
matches the package version. Existing versions are skipped on ordinary
non-release pushes to `main`.

## Release gates

Before a release branch merges, `.github/workflows/ci.yml` validates linting,
the Electron type check, Vitest without the native-bridge integration test, and
the web build. When Rust sources or bridge build scripts change,
`.github/workflows/rust-bridge.yml` also formats, builds, tests, and probes the
native bridge on Apple Silicon.

The source-release workflow repeats the release-critical checks on the exact
merged commit:

- `npm ci`
- `npm run lint`
- `npx tsc --noEmit -p tsconfig.electron.json`
- `npm run test:js`
- `npm run build:web`

The tag and GitHub Release are created only after those checks pass and a
matching checked-in release-notes file is present.

## Cut a release

1. Set the same semantic version in `package.json` and `package-lock.json`.
2. Move the accumulated changelog entries into a dated version section and add
   `docs/releases/vMAJOR.MINOR.PATCH.md`.
3. Run `npm run lint`, `npm run typecheck`, `npm run test`,
   `npm run build:web`, and `npm run build:electron:main`.
4. Commit every release input, including `rust/vendor/`; CI cannot build an
   untracked path dependency.
5. Open a release pull request against `main` and wait for all required checks.
6. Merge the pull request. The verified `main` push creates the tag and
   source-only GitHub Release automatically.

## Local desktop packages

Developers can still build unsigned desktop packages locally:

- Apple Silicon macOS 26+: `npm run dist:mac`
- Windows x64: `npm run dist:win` with a compatible LibTorch 2.7.0 installation

Local packages bundle the Electron shell, native bridge, provider resources, and
required native libraries, but not model weights. They are unsigned,
unnotarized, and must not be attached to an official GitHub Release until a
proper signing and notarization process is in place.
