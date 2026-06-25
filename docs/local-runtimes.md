# Desktop Local Runtimes

Electron exposes optional Rust-only local-runtime integrations for NeuTTS Nano and Qwen3-TTS. The desktop package includes the Electron app, the `open-tts-local-bridge` binary, and optional native runtime tools. It does not include model weights. Browser models and Candle fallback models download assets into app caches, while Qwen3 MLX profiles use user-selected local model directories or a per-user Electron app cache.

There is no Electron-facing one-shot generation action, interpreter discovery, adapter script, or managed virtual environment. The local runtime path is Rust from Electron process launch through the authenticated WebSocket bridge; Qwen3 MLX CustomVoice may call the upstream native `tts` binary inside that resident bridge process.

## Available Runtimes

| Runtime | Rust crate | Route | Notes |
|---|---|---|---|
| NeuTTS Nano | `neutts` | `/desktop/neutts` | Uses Neuphonic GGUF variants and pre-encoded `.npy` reference codes |
| Qwen3-TTS CustomVoice 6-bit | upstream `qwen3_tts_rs` MLX `tts` | `/desktop/qwen3` | Default macOS profile; uses Apple Silicon MLX with built-in speakers and no reference audio |
| Qwen3-TTS Base 6-bit voice cloning | upstream `qwen3_tts_rs` MLX worker | `/desktop/qwen3` | Advanced profile; uses Apple Silicon MLX streamed PCM worker protocol with reference WAV cloning |
| Qwen3-TTS CustomVoice Candle | `qwen_tts` | `/desktop/qwen3` | Fallback profile; uses Qwen CustomVoice safetensors through Candle Metal on macOS when available, with CPU fallback |

Kani-TTS-2 is retired from the app because there is no Rust runtime crate replacing its previous interpreter-only implementation.

## NeuTTS Nano

Open TTS uses the Rust `neutts` crate with Neuphonic GGUF model repositories:

- `neuphonic/neutts-nano-q4-gguf`
- `neuphonic/neutts-nano-q8-gguf`
- German, French, and Spanish Q4/Q8 variants

The Rust crate accepts pre-encoded reference code arrays (`.npy`) or a mono WAV reference clip. Upload a `.npy` file containing NeuCodec codes, or a WAV clip that the bridge encodes on first use via its bundled NeuCodec encoder (~1.8 GB one-time download). Provide the matching reference transcript for either path.

Generation is whole-text. Short outputs arrive as one binary Float32 audio chunk; very long outputs may be split at transport time when the buffered sample count exceeds the bridge chunk cap.

## Qwen3-TTS MLX First

Open TTS defaults Qwen3 on macOS to the upstream MLX CustomVoice 6-bit profiles:

- `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit`
- `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit`

These are the built-in-speaker CustomVoice models converted for MLX. They do not require reference audio or reference transcripts. When `OPEN_TTS_QWEN3_MLX_API_SERVER` is available (bundled in `dist-rust/` or set explicitly), the bridge keeps that server resident and streams SSE PCM deltas as multiple WebSocket audio chunks (`total: 0` until the final `audioChunkCount`). When `api_server` is missing, the bridge falls back to the upstream `tts` CLI per text unit, reads each generated `output.wav`, converts it to Float32, and relays it through the app's normal WebSocket binary transport (one chunk per unit with a known `total`).

Base voice cloning remains available as explicit advanced MLX profiles:

- `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit`
- `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-6bit`

The page shows MLX setup status from Electron: whether the required `tts` or `pibot-tts-worker` binary is available on the current machine, the recommended per-user app-cache model directory, and shell commands to build the tools or download the recommended Hugging Face model. The MLX model directory can be typed manually or selected through a native Electron directory picker.

Candle CustomVoice remains available through the Rust `qwen_tts` crate:

- `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`
- `auto`, which resolves to the 0.6B model

The Candle CustomVoice path uses eager attention and supports `float32` and `bfloat16` (Metal only) dtypes; `auto` resolves to `bfloat16` on Metal and `float32` on CPU. BF16 roughly halves weight memory traffic on Apple Silicon (~1.5-2x faster inference) — precision-sensitive steps (logits, sampling) still run in float32 inside `qwen_tts`, and the audio output is converted to float32. Pick `float32` explicitly if you suspect BF16 audio artifacts. Device `auto` is Apple-first: it tries Candle Metal on macOS and falls back to CPU when Metal is unavailable. The UI also exposes explicit Apple Metal and CPU choices on macOS; non-macOS builds expose Auto and CPU.

Supported UI languages are Auto, Chinese, English, Japanese, Korean, German, French, and Spanish. The page also exposes speaker, optional instruction prompt, temperature, top-k, top-p, and max token controls. The default max-token cap is 1536 to keep short local generations practical; users can raise it for longer or more exploratory runs.

MLX CustomVoice generation prefers the resident `api_server` path when installed; the one-shot `tts` CLI is the fallback. Neither path is voice cloning and neither needs reference audio. Candle CustomVoice generation stays on the `qwen_tts` backend. The bridge splits longer text into sentence-sized units, generates each unit with `generate_custom_voice_from_text()`, and sends each unit as a WebSocket audio chunk as soon as that unit finishes (0.2s trailing silence between units). This improves time-to-first-audio for longer Candle fallback requests, but it is not token-level autoregressive streaming from inside `qwen_tts`; a single short unit still arrives after that unit's inference completes.

Base voice cloning is a separate upstream-compatible MLX backend integration inside `open-tts-local-bridge`. The adapter keeps a matching `pibot-tts-worker` resident, sends target text through its binary frame protocol, converts streamed PCM i16 chunks to Float32, and relays them through the app's authenticated WebSocket transport. The worker is reused while model directory, reference WAV bytes, reference transcript, language, output sample rate, block size, streaming chunk size, top-k, temperature, and max-new-token settings match. Configure it with:

- `OPEN_TTS_QWEN3_MLX_API_SERVER`: path to an `api_server` binary built from `badlogic/qwen3_tts_rs` with `--no-default-features --features mlx` for resident MLX CustomVoice (preferred fast path).
- `OPEN_TTS_QWEN3_MLX_TTS`: path to a `tts` binary built from `badlogic/qwen3_tts_rs` with `--no-default-features --features mlx` for MLX CustomVoice one-shot fallback.
- `OPEN_TTS_QWEN3_MLX_WORKER`: path to a `pibot-tts-worker` binary built from the same checkout for Base voice cloning.
- `baseModelPath` from the UI, or `OPEN_TTS_QWEN3_MLX_MODEL_DIR`: local MLX model directory for the selected CustomVoice or Base 6-bit model.

The adapters expect a local model directory because the upstream tools do not download Hugging Face repos by ID. To fetch/build the default upstream MLX binaries on Apple Silicon:

```sh
npm run build:qwen3-mlx-worker
npm run build:rust
```

`npm run build:qwen3-mlx-worker` clones `badlogic/qwen3_tts_rs` into `rust/qwen3_tts_rs/`, initializes its `mlx-c` submodule, applies the bundled MLX compatibility patches from `patches/qwen3_tts_rs/`, and builds `tts`, `pibot-tts-worker`, and `api_server` with `--no-default-features --features mlx`. `scripts/build-rust-bridge.mjs` then copies those tools into `dist-rust/`.

To fetch/build every upstream MLX binary defined by that checkout's Cargo manifest:

```sh
npm run build:qwen3-mlx-tools
```

That builds the default tools plus the voice-clone CLI, OpenAI-compatible API server, and trace/vocoder tools when those targets exist. The API server patch keeps MLX work on a current-thread runtime and binds MLX's thread-local default stream on each generation path, which avoids `There is no Stream(gpu, 0) in current thread` failures in both non-streaming and SSE generation. For a single command that builds all upstream MLX tools and then packages the bridge resources, run:

```sh
npm run build:rust:all
```

`scripts/build-rust-bridge.mjs` will also copy Qwen3 MLX binaries into `dist-rust/` when `OPEN_TTS_QWEN3_MLX_TTS` or `OPEN_TTS_QWEN3_MLX_WORKER` points to a built tool, or when it finds a local build under `OPEN_TTS_QWEN3_TTS_RS_DIR`, `rust/qwen3_tts_rs/`, `rust/qwen3-tts-rs/`, or `vendor/qwen3_tts_rs/`. Electron automatically points the bridge at bundled `dist-rust/tts` and `dist-rust/pibot-tts-worker` when they exist. The renderer generation path still goes through the authenticated resident bridge worker.

Speaker names are shown capitalized in the UI (`Ryan`, `Vivian`, `Serena`, `Uncle_Fu`, `Dylan`, `Eric`, `Aiden`, `Ono_Anna`, `Sohee`), but the model's `talker_config.spk_id` keys are lowercase and `qwen_tts` speaker validation is case-sensitive. The Rust bridge lowercases the speaker (e.g. `Ryan` → `ryan`, `Uncle_Fu` → `uncle_fu`) before generation; the UI/IPC keep the capitalized display names.

Model weights are never checked into the open-source repository and are not bundled into Electron packages. The repository ignores local caches such as `.model-cache/`, `reports/`, and generated `dist*` outputs. On an end-user machine, model assets live under the user's app data cache unless the user selects a different local model directory.

First browser/Candle generation may download model assets into that user's cache, and CPU fallback inference can run for minutes. Qwen3 MLX generation requires the user to download the MLX model from the app, run the shown `hf download` command, or choose an existing local model directory. These are single blocking calls, so the bridge emits a periodic stderr heartbeat for the duration of each request to keep the host's inactivity watchdog armed; the watchdog only fires when the worker goes fully silent. Inside the bridge, reads from the resident MLX worker/api_server carry a 10-minute output-inactivity deadline, so a wedged child surfaces an error instead of hanging behind the heartbeat.

## Qwen3 Profiling

Use the profiling CLI before changing Qwen kernels, model backends, or bridge transport behavior. It runs the same authenticated `serve-ws` path as Electron for local bridge targets, records per-run phase timings, and writes a JSON report under `reports/qwen3-profile/`.

```sh
npm run profile:qwen3 -- --target=candle,mlx-api --base-model-path /path/to/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit
```

The report records target/backend, model repo, device, text length, generated audio duration, wall-clock seconds, bridge elapsed seconds, wall-clock RTF, bridge RTF, audio chunk count, and phase timings such as `modelLoadSec`, `firstAudioSec`, `inferenceSec`, `outputEncodingSec`, and `transportEncodingSec`. Warmup runs are included in `runs` but excluded from `summary`, so `--warmups=0` captures cold-start behavior and the default `--warmups=1` emphasizes resident-model throughput.

SGLang-Omni can be included as an external comparison target when a compatible server is already running:

```sh
npm run profile:qwen3 -- --target=candle,mlx-api,sglang --base-model-path /path/to/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit --sglang-url http://127.0.0.1:8000/v1/audio/speech
```

Use `npm run profile:qwen3 -- --help` for the full option list, including prompt text, speaker, language, instruction prompt, decoding settings, output path, and cache directory overrides.

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

`serve-ws` binds the requested loopback host, prints `__PORT__<actual-port>` on stdout, and accepts a WebSocket connection only on `/<token>` using `tungstenite` for upgrade validation and frame handling. Electron uses `--port 0` so Rust owns the final port selection and there is no host-side reserve/bind race.

Once connected, `serve-ws` reads WebSocket requests shaped like `{"requestId","payload"}`, `{"command":"warm","requestId","payload"}`, or `{"command":"shutdown"}`. Per generation request it emits zero or more `progress` JSON frames, then one or more `audio_chunk` JSON frames. Each `audio_chunk` is immediately followed by one binary Float32 frame. MLX `api_server` CustomVoice, MLX Base voice-clone streaming, and other open-ended streams may use `total: 0` while chunks arrive and rely on the final result's `audioChunkCount`. Candle CustomVoice sentence units, MLX `tts` fallback units, and NeuTTS outputs include a known `total` (NeuTTS may split only when buffered audio exceeds the transport chunk cap). A final `result` JSON frame closes the request. Invalid request JSON is logged and ignored without tearing down the server. Client disconnect during send closes that connection only.

Successful results include:

- `sampleRate`
- `modelRepo`
- `durationSec`
- `elapsedSec`
- optional `device`
- optional `warnings`
- `audioTransport: "websocket-binary"`
- `audioChunkCount`
- `phaseTimingsSec`

`wavBase64` is not supported on the local runtime path.

## Resident Worker

Generation uses a resident WebSocket worker pool in `electron/webSocketBridgeWorker.ts`. The bridge process serves repeated requests for that model until it is idle-evicted or cancelled. Before killing the bridge child, the host sends `{"command":"shutdown"}` on the open WebSocket when possible so resident MLX children are dropped cleanly. Qwen3 Candle CustomVoice keeps the Candle model resident by repository/device/dtype/attention. Qwen3 MLX CustomVoice keeps the upstream `api_server` resident when available; otherwise it invokes `tts` per text unit inside the bridge. Qwen3 Base voice cloning keeps the upstream MLX `pibot-tts-worker` resident by model/reference/settings, so repeat text generations with the same voice clone avoid a full worker restart. Requests are serialized per model by `generateRateLimiter`, so a resident model is never entered concurrently.

The bridge uses the literal `127.0.0.1` and sets `TCP_NODELAY` on accepted loopback sockets best-effort. WebSocket upgrade validation and frame parsing/writing are handled by `tungstenite`; inbound requests must be masked and stay within the bridge's frame size cap. Audio bytes are raw Float32 with only NaN/Inf cleanup in Rust; renderer-side playback uses Web Audio, and renderer-side WAV encoding owns peak normalization.

## Packaging (macOS)

`scripts/build-rust-bridge.mjs` copies the bridge binary, optional Qwen3 MLX binaries, and native bridge dylibs into `dist-rust/`, which `electron-builder` ships as `extraResources`. On macOS the script also makes the bundle self-contained: it transitively copies external Homebrew dependencies the build links against (e.g. `libomp`, `openssl@3`'s `libssl`/`libcrypto`) into `dist-rust/`, rewrites every absolute install name to `@rpath`, adds the `@executable_path`/`@loader_path` rpath so `@rpath` resolves to the bundle directory, and re-signs each artifact ad-hoc so it still loads on Apple Silicon. Without this, a packaged build would fail to launch on machines without those Homebrew libraries. Distributed builds still require a Developer ID signature and notarization (configure `build.mac` in `package.json`); the ad-hoc signature is only for local/dev runs.

## Cache

Model assets are stored under the app data local model cache. The runtime sets Hugging Face cache environment variables under that per-model cache directory so NeuTTS and Qwen3 assets stay isolated and repeat loads can reuse downloaded files.

## Probe And MLX Setup

Probe reports Rust runtime readiness and package metadata. Qwen3 probe reports the recommended MLX CustomVoice model repository, the Base clone repository, and the Candle fallback settings. The renderer separately asks Electron for MLX setup metadata: `tts` availability, worker availability, bundled or environment-provided paths, the recommended local model directory, and the download/build commands shown in the UI. NeuTTS probe warns that `.npy` reference codes are required.

A successful probe means the Rust bridge can start and the selected runtime is compiled into the binary. It does not prove every model file is already downloaded or every generation request will succeed.

## Troubleshooting

| App message | Meaning | Fix |
|---|---|---|
| `Rust local bridge exited...` | The desktop app could not run the bridge binary | Run `npm run build:rust`, then restart Electron |
| `NeuTTS Rust references must be pre-encoded .npy code files` | A WAV or other file type was selected for NeuTTS | Upload a `.npy` reference-code file |
| `referenceCodesBase64 is required` | NeuTTS generation was submitted without reference codes | Upload a reference `.npy` file before generating |
| `Unsupported Qwen3-TTS dtype` | A request used a dtype outside the Rust-supported set | Use Auto, float32, or bfloat16 (Metal only) |
| `Unsupported Qwen3-TTS attention implementation` | A request used attention outside the Rust-supported set | Use eager |
| `Local bridge timed out` | The one-shot probe did not return within its deadline | Rebuild the Rust bridge and check stderr logs |
