# Development

Requirements, setup, scripts, packaging, and benchmarks for working on Open TTS.
Architecture lives in [architecture.md](./architecture.md) and the release
process in [releasing.md](./releasing.md).

## Requirements

- Node.js 24.19.0 LTS is recommended. Supported releases are Node.js 22.22.2+, 24.15.0+, and 26.x; odd-numbered releases are intentionally excluded.
- npm 11.17.0 or newer. Node bundles its own npm, which may be older — check `npm -v` rather than assuming. An out-of-range npm fails the install with `EBADENGINE`; upgrade with `npm install -g npm@11.17.0`. See [Install scripts](#install-scripts) for why this is enforced.
- [rustup](https://rustup.rs/) for Electron desktop development, desktop builds, packaging, and Rust bridge tests. `rust-toolchain.toml` pins Rust 1.97.1 with `clippy` and `rustfmt`; a Rust installed through Homebrew or a distribution package manager ignores that pin.
- Desktop builds run on Apple Silicon macOS or Windows x64 only. `npm run setup:desktop` rejects Intel macOS, Windows on Arm, and Linux outright.
- Native prerequisites for desktop builds, which `npm run setup:desktop` hard-fails on rather than installing for you:
  - macOS: `brew install cmake libomp openssl@3 pkg-config automake autoconf libtool`, plus Xcode's Metal Toolchain (`xcodebuild -downloadComponent MetalToolchain`), which newer Xcode releases no longer include by default
  - Windows: CMake on `PATH`, plus `LIBTORCH` pointing at a LibTorch 2.7.0 release directory
- The Rust scripts build for the app's minimum macOS (`minimumSystemVersion`, currently 26.0) unless `MACOSX_DEPLOYMENT_TARGET` is already set, matching CI, so a bridge built on a newer macOS still runs on the oldest supported release.
- The web app alone can run without Rust; desktop commands build `rust/local-tts-bridge` before launching Electron.
- Optional document tools for desktop imports: LibreOffice for Office/OpenDocument files, ImageMagick for images, and Ghostscript for PDFs that require it.

## Setup

```bash
npm run setup:web      # reproducible web dependency setup
npm run dev:web        # web app -> http://localhost:5173/studio

npm run setup:desktop  # dependency setup + native prerequisite checks
npm run dev:desktop    # Vite + Electron desktop app
```

The setup commands use the exact lockfile and print actionable prerequisites instead of silently modifying system tools. `npm run doctor:desktop` runs the same Node, npm, platform, and native prerequisite checks without installing anything. The verified Node version lives in `.nvmrc`, so running `nvm use` in the repository root selects it. Changing that pin carries one constraint — see [Install scripts](#install-scripts).

The web app is served at [`http://localhost:5173/studio`](http://localhost:5173/studio).
The Electron app opens the desktop shell under `/desktop/*`. Supertonic 3 appears only in this desktop shell and downloads its pinned ONNX assets on first selection. Qwen3 appears after the Rust bridge probes successfully; selecting it exposes shared voice controls inline, while **Model setup** opens guided download, repair, voice-clone, and VoiceDesign configuration.

The dedicated NeuTTS and Qwen setup pages are hidden by default; enable them under **Settings → Optional models**. Qwen remains selectable inside Studio and Reader either way.

## Install scripts

`.npmrc` sets `strict-allow-scripts=true` and `package.json` carries an `allowScripts` map, so only vetted dependencies may run install scripts. Any other package that ships one **fails the install** rather than executing unreviewed code. `engines.npm` and `engine-strict=true` enforce the npm 11.17.0 floor this depends on.

The allowlist pins exact versions (`esbuild@0.28.2`, `onnxruntime-node@1.27.0`, `sharp@0.34.5`, and so on), so **bumping one of those dependencies breaks `npm ci` until the allowlist is updated in the same commit**. Run `npm approve-scripts --allow-scripts-pending` to list what a bump left uncovered, and `npm approve-scripts <pkg>` to record the new pin.

<details>
<summary>Why both settings are required, and what else they constrain</summary>

<br>

**Why `engine-strict` and not `engines.npm` alone.** npm older than 11.17.0 does not understand `strict-allow-scripts` or `allowScripts`; it ignores both and runs every install script silently. `engines.npm` on its own only prints `npm warn EBADENGINE` and still exits 0 — which would install the tree with the policy switched off. `engine-strict=true` turns that warning into a refusal. `npm run setup:web` and `npm run setup:desktop` check the version and stop even earlier.

**It applies to dependencies too.** `engine-strict` enforces `engines` ranges across the whole tree, not just this package. Optional dependencies are exempt, which is what keeps the unmet platform-specific optional packages from tripping it. A bump that introduces a stricter `engines` range on a non-optional package will fail the install; the `EBADENGINE` error names the offending package.

**It constrains `.nvmrc`.** Because `engines.npm` is binding, pinning Node to a line whose bundled npm is older than 11.17.0 would fail `npm ci` for every contributor and every CI job. Whoever bumps the Node pin should check `npm -v` under the candidate version and either confirm it satisfies `engines.npm` or bump `engines.npm` in the same commit.

</details>

## All scripts

| Command | Description |
|---|---|
| `npm run setup:web` | Install the exact lockfile dependencies for web development |
| `npm run setup:desktop` · `npm run doctor:desktop` | Install/check desktop dependencies and validate native prerequisites |
| `npm run dev` · `npm run dev:web` | Vite web app on `localhost:5173` |
| `npm run dev:desktop` · `npm run dev:electron` | Vite + Electron desktop app |
| `npm run build` · `npm run build:web` | Type check + production web build |
| `npm run build:rust` | Build and copy the Rust local bridge into `dist-rust/` |
| `npm run build:desktop` · `npm run build:electron` | Web build + Rust bridge + compile Electron main process |
| `npm run dist` | Package the desktop app into `release/` |
| `npm run dist:mac` | Package the Apple Silicon macOS DMG and ZIP |
| `npm run dist:win` | Package the Windows x64 NSIS installer (`LIBTORCH` required) |
| `npm run dist:signed:mac` | Build a Developer ID-signed, hardened, notarized macOS release; requires Electron Builder signing and Apple credentials |
| `npm run dist:signed:win` | Build a signed Windows NSIS release; requires LibTorch plus Windows signing credentials |
| `npm run preview` | Preview the production web build locally |
| `npm run lint` | ESLint |
| `npm run lint:rust` | Clippy over the Rust local bridge with warnings denied; required by CI for Rust changes and needs the native build prerequisites |
| `npm run typecheck` | TypeScript check across renderer, build tooling, and Electron main/tests |
| `npm run test` | Vitest + Rust bridge unit tests |
| `npm run test:js` · `npm run test:watch` · `npm run test:coverage` | Vitest |
| `npm run test:rust` | Rust bridge unit tests |
| `npm run test:rust:policy` | Model-free Rust lifecycle, text, and sampling tests; no MLX, Metal, or LibTorch needed |
| `npm run eval:inference` | Reproducible inference-speed benchmark (see [docs](./performance.md)) |

Packaged desktop builds bundle the Electron shell and the Rust local bridge. They do **not** ship model weights; first use downloads model assets into the app data cache. On macOS the Rust executables are made self-contained, so a packaged build runs without Homebrew. Tagged releases are source-only; macOS and Windows packages remain local build outputs. See [local runtime setup](./local-runtimes.md).

## Releases and packaging

The [latest GitHub Release](https://github.com/cyanxxy/Local-TTS-studio/releases/latest) contains the tagged source archive and curated release notes. Open TTS does not publish unsigned desktop installers.

**Local builds.** Developers can create local packages with `npm run dist:mac` on Apple Silicon macOS 26+ or `npm run dist:win` on Windows x64 with a compatible LibTorch 2.7.0 installation. These builds are unsigned and unnotarized, do not bundle model weights, and are not attached to GitHub Releases.

**Signed builds.** For end-user distribution, `npm run dist:signed:mac` and `npm run dist:signed:win` build against `electron-builder.release.mjs`, which sets `forceCodeSigning` so the build fails rather than emitting an unsigned artifact. macOS additionally enables the hardened runtime and notarization, and aborts before packing unless a complete set of Apple notarization credentials is present.

Both signed commands are run by a maintainer on the target platform. No workflow in this repository packages, signs, or notarizes desktop builds, and no signing secrets are configured under `.github/` — certificates and Apple/Microsoft credentials live in the maintainer's environment and are never committed. See the [release process](./releasing.md) for the source-release workflow, local packaging checks, and the exact credentials each platform expects.

## Performance and evaluation

Open TTS ships a reproducible browser-inference evaluation harness instead of presenting one machine's result as a universal benchmark:

```bash
npm run eval:inference
npm run eval:inference -- --model kokoro --iterations 3 --warmups 1
npm run eval:inference -- --model supertonic --iterations 3 --warmups 1
npm run eval:inference -- --model supertonic3   # or --model all
```

Each report records model/backend identity, WebGPU availability, load and generation latency, first-chunk latency, characters per second, real-time factor, warm-up count, and measured iterations. Reports are written under `reports/inference-speed/` and can be compared with `--baseline` to catch regressions on the same hardware and software stack.

Qwen performance must be measured separately for each native provider and model profile: MLX/Metal on Apple Silicon, LibTorch CUDA on Windows x64 with a compatible GPU, or LibTorch CPU fallback. Browser eval numbers and results from the removed pre-v1.2 child-server architecture are not valid Qwen native-backend comparisons. See [Performance benchmarks](./performance.md) for the complete methodology and reporting checklist.

Contributors: the release gate is `npm run lint`, `npm run test`, and `npm run build`, plus `npm run lint:rust` for Rust changes. See the [release process](./releasing.md) for the full CI matrix.
