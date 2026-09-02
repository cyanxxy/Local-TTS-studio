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
the web build. `.github/workflows/rust-bridge.yml` additionally checks
formatting, then builds, Clippy-lints, tests, and probes the native bridge on
Apple Silicon; it triggers on changes to Rust sources, the bridge build scripts,
`rust-toolchain.toml`, `.npmrc`, `.nvmrc`, `package.json`, and
`package-lock.json`.

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
   `npm run build:web`, and `npm run build:electron:main`. Add
   `npm run lint:rust` when the release contains Rust changes; it is a required
   check in `.github/workflows/rust-bridge.yml`.
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

## Signed release builds

Credentialed release builds use `electron-builder.release.mjs`, which sets
`forceCodeSigning` on both platforms so the build fails rather than emitting an
unsigned artifact:

- Apple Silicon macOS 26+: `npm run dist:signed:mac` with `CSC_LINK`,
  `CSC_KEY_PASSWORD`, and Apple notarization credentials.
- Windows x64: `npm run dist:signed:win` with `LIBTORCH` plus `WIN_CSC_LINK` and
  `WIN_CSC_KEY_PASSWORD` (or configured Azure Trusted Signing).

**No workflow in this repository runs either command.** `release-desktop.yml`
has only `ubuntu-24.04` jobs, there is no macOS or Windows packaging job, and no
signing secret is referenced anywhere under `.github/`. A maintainer runs these
builds by hand on the target platform. Keep certificates and passwords in that
machine's environment or keychain; do not place them in repository files.

### Apple notarization credentials

The macOS config sets `notarize: true`, and `app-builder-lib` 26 picks exactly
one of three credential routes, in this order
(`out/mac/MacTargetHelper.js`, `getNotarizeOptions`):

1. **App-specific password** — `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
   `APPLE_TEAM_ID`. Setting either of the first two selects this route, and all
   three must then be present or the build errors out.
2. **App Store Connect API key** — `APPLE_API_KEY` (path to the `.p8`),
   `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Setting any one selects this
   route and all three are then required. `APPLE_TEAM_ID` is not used here.
3. **Keychain profile** — `APPLE_KEYCHAIN_PROFILE`, the name stored by
   `xcrun notarytool store-credentials`, with optional `APPLE_KEYCHAIN` to point
   at a non-default keychain. This route is local-only; it cannot travel to a
   fresh CI runner.

`notarize: true` alone does not fail closed: with no credentials in the
environment, `app-builder-lib` logs `skipped macOS notarization` and still exits
0 with a signed but un-notarized artifact. `electron-builder.release.mjs`
therefore asserts one complete route in a `beforePack` hook and aborts the macOS
build before any packing work happens, so `npm run dist:signed:mac` cannot
produce an un-notarized DMG.
