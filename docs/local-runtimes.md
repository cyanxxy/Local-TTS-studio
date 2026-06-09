# Desktop Local Runtimes

Electron exposes optional Rust-only local-runtime integrations for NeuTTS Nano and Qwen3-TTS. The desktop package includes the Electron app and the `open-tts-local-bridge` binary. It does not include model weights; first use downloads model assets into the app data cache.

There is no interpreter discovery, adapter script, managed virtual environment, or one-shot generation subprocess. The local runtime path is Rust from Electron process launch through model execution.

## Available Runtimes

| Runtime | Rust crate | Route | Notes |
|---|---|---|---|
| NeuTTS Nano | `neutts` | `/desktop/neutts` | Uses Neuphonic GGUF variants and pre-encoded `.npy` reference codes |
| Qwen3-TTS CustomVoice | `qwen_tts` | `/desktop/qwen3` | Uses Qwen CustomVoice safetensors through Candle CPU execution |

Kani-TTS-2 is retired from the app because there is no Rust runtime crate replacing its previous interpreter-only implementation.

## NeuTTS Nano

Open TTS uses the Rust `neutts` crate with Neuphonic GGUF model repositories:

- `neuphonic/neutts-nano-q4-gguf`
- `neuphonic/neutts-nano-q8-gguf`
- German, French, and Spanish Q4/Q8 variants

The Rust crate consumes pre-encoded reference code arrays. Upload a `.npy` file containing those codes, then provide the matching reference transcript. WAV reference upload is not part of the Rust-only path because the crate does not implement a pure Rust WAV-to-code encoder. Produce the `.npy` externally by encoding a 3–15s mono reference clip with NeuCodec from the upstream Neuphonic NeuTTS project (`github.com/neuphonic/neutts-air`).

Generation is whole-text and streams as one binary Float32 audio chunk.

## Qwen3-TTS CustomVoice

Open TTS uses the Rust `qwen_tts` crate for Qwen3-TTS CustomVoice:

- `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`
- `auto`, which resolves to the 0.6B model

The current Rust path exposes CPU execution with `float32` dtype and `eager` attention. The UI keeps device, dtype, and attention controls constrained to those supported values.

Supported UI languages are Auto, Chinese, English, Japanese, Korean, German, French, and Spanish. The page also exposes speaker, optional instruction prompt, temperature, top-p, and max token controls.

Speaker names are shown capitalized in the UI (`Ryan`, `Vivian`, `Serena`, `Uncle_Fu`, `Dylan`, `Eric`, `Aiden`, `Ono_Anna`, `Sohee`), but the model's `talker_config.spk_id` keys are lowercase and `qwen_tts` speaker validation is case-sensitive. The Rust bridge lowercases the speaker (e.g. `Ryan` → `ryan`, `Uncle_Fu` → `uncle_fu`) before generation; the UI/IPC keep the capitalized display names.

First generation downloads the model (roughly 1–2 GB) and CPU inference can run for minutes. These are single blocking calls, so the bridge emits a periodic stderr heartbeat for the duration of each request to keep the host's inactivity watchdog armed; the watchdog only fires when the worker goes fully silent.

## Bridge Protocol

`open-tts-local-bridge` has exactly two actions:

- `probe`
- `serve-ws`

Electron launches probe as:

```sh
open-tts-local-bridge --action probe --model <neutts|qwen3> --cache-dir <dir>
```

Electron launches generation workers as:

```sh
open-tts-local-bridge --action serve-ws --model <neutts|qwen3> --cache-dir <dir> --host 127.0.0.1 --port 0 --auth-token <token>
```

`serve-ws` binds the requested loopback host, prints `__PORT__<actual-port>` on stdout, and accepts a WebSocket connection only on `/<token>`. Electron uses `--port 0` so Rust owns the final port selection and there is no host-side reserve/bind race.

Once connected, `serve-ws` reads WebSocket requests shaped like `{"requestId","payload"}` or `{"command":"shutdown"}`. Per generation request it emits zero or more `progress` JSON frames, then an `audio_chunk` JSON frame immediately followed by one binary Float32 frame, then one `result` JSON frame.

Successful results include:

- `sampleRate`
- `modelRepo`
- `durationSec`
- `elapsedSec`
- `audioTransport: "websocket-binary"`
- `audioChunkCount`
- `phaseTimingsSec`

`wavBase64` is not supported on the local runtime path.

## Resident Worker

Generation uses a resident WebSocket worker pool in `electron/webSocketBridgeWorker.ts`. The bridge process loads a model once and serves repeated requests for that model until it is idle-evicted or cancelled. Requests are serialized per model by `generateRateLimiter`, so a resident model is never entered concurrently.

The bridge uses the literal `127.0.0.1` and sets `TCP_NODELAY` on accepted loopback sockets best-effort. Inbound WebSocket requests must be masked and stay within the bridge's frame size cap. Audio bytes are raw Float32 with only NaN/Inf cleanup in Rust; renderer-side playback uses Web Audio, and renderer-side WAV encoding owns peak normalization.

## Packaging (macOS)

`scripts/build-rust-bridge.mjs` copies the bridge binary and its `ggml`/`llama`/`mtmd` dylibs into `dist-rust/`, which `electron-builder` ships as `extraResources`. On macOS the script also makes the bundle self-contained: it transitively copies external Homebrew dependencies the build links against (e.g. `libomp`, `openssl@3`'s `libssl`/`libcrypto`) into `dist-rust/`, rewrites every absolute install name to `@rpath`, adds the `@executable_path`/`@loader_path` rpath so `@rpath` resolves to the bundle directory, and re-signs each artifact ad-hoc so it still loads on Apple Silicon. Without this, a packaged build would fail to launch on machines without those Homebrew libraries. Distributed builds still require a Developer ID signature and notarization (configure `build.mac` in `package.json`); the ad-hoc signature is only for local/dev runs.

## Cache

Model assets are stored under the app data local model cache. The runtime sets Hugging Face cache environment variables under that per-model cache directory so NeuTTS and Qwen3 assets stay isolated and repeat loads can reuse downloaded files.

## Probe

Probe reports Rust runtime readiness and package metadata. Qwen3 probe also reports the recommended CPU/`float32`/`eager` execution profile. NeuTTS probe warns that `.npy` reference codes are required.

A successful probe means the Rust bridge can start and the selected runtime is compiled into the binary. It does not prove every model file is already downloaded or every generation request will succeed.

## Troubleshooting

| App message | Meaning | Fix |
|---|---|---|
| `Rust local bridge exited...` | The desktop app could not run the bridge binary | Run `npm run build:rust`, then restart Electron |
| `NeuTTS Rust references must be pre-encoded .npy code files` | A WAV or other file type was selected for NeuTTS | Upload a `.npy` reference-code file |
| `referenceCodesBase64 is required` | NeuTTS generation was submitted without reference codes | Upload a reference `.npy` file before generating |
| `Unsupported Qwen3-TTS dtype` | A request used a dtype outside the Rust-supported set | Use Auto or float32 |
| `Unsupported Qwen3-TTS attention implementation` | A request used attention outside the Rust-supported set | Use Auto or eager |
| `Local bridge timed out` | The one-shot probe did not return within its deadline | Rebuild the Rust bridge and check stderr logs |
