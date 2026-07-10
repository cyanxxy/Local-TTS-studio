# Electron local runtimes

Electron exposes NeuTTS Nano and Qwen3-TTS through one compiled executable: `open-tts-local-bridge`. The desktop package does not require Python and does not launch model-specific adapter programs. Model weights remain per-user downloads.

## Architecture

```text
React renderer
  │ trusted Electron IPC
  ▼
Electron main process
  │ authenticated ws://127.0.0.1:<port>/<token>
  ▼
open-tts-local-bridge (resident Rust process)
  ├─ NeuTTS / GGUF
  └─ Qwen3-TTS / pinned qwen3-tts-rs
       ├─ Apple Silicon: MLX + Metal
       └─ Windows: LibTorch CUDA, then LibTorch CPU
```

Electron has one backend contract regardless of platform. Platform selection happens at compile/runtime inside Rust; renderer requests never select a tensor engine, dtype, or attention implementation.

The bridge supports exactly two process actions:

- `probe`: one-shot runtime metadata.
- `serve-ws`: resident generation and warm-up server.

There is no one-shot generation action and no stdout/base64 audio fallback.

## Qwen3 profiles

`electron/qwen3Profiles.ts` is the authoritative profile table. It contains four Apple MLX profiles and four Windows LibTorch profiles: CustomVoice and Base, each at 0.6B and 1.7B. Every profile fixes:

- repository and immutable Hugging Face revision;
- provider and supported platform;
- model mode and parameter size;
- weight format;
- required runtime files.

The default is the platform's 0.6B CustomVoice profile: 6-bit MLX on Apple Silicon and standard safetensors with LibTorch on Windows. The 1.7B profiles remain explicit quality choices.

CustomVoice provides nine built-in speakers and needs no reference audio. Base performs voice cloning and requires a WAV plus the exact reference transcript. Both accept Auto plus Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, and Italian.

## Model downloads and validation

The Electron main process owns downloads through `electron/qwen3ModelDownload.ts`.

1. Resolve only the selected profile's exact revision.
2. Select only the profile's required files.
3. Write each response to a `.download` path.
4. Validate declared length and available Hub SHA-256 metadata.
5. Atomically promote the completed file.
6. Compute local SHA-256 values and write `open-tts-model.json` last.

The manifest records the repository, revision, paths, sizes, and digests. Setup reports one of three states:

- `missing`: incomplete or wrong model type;
- `structural`: required files and model type look valid, but no matching verified manifest exists;
- `verified`: all required files match the immutable manifest.

This permits advanced users to choose an existing directory without misrepresenting it as a verified app download. Rust validates the directory and `tts_model_type` again before loading it.

## Qwen3 request contract

Generation payloads are strict and reject unknown fields. Supported fields are:

```json
{
  "text": "Text to speak",
  "mode": "customVoice",
  "modelRepo": "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
  "modelPath": "/absolute/model/directory",
  "speaker": "Ryan",
  "language": "English",
  "instruct": "Speak warmly",
  "temperature": 0.9,
  "topK": 50,
  "maxNewTokens": 1536
}
```

Base mode replaces speaker/instruction with `referenceAudioBase64` and `referenceText`. Backend-internal controls are intentionally absent.

Warm-up uses only `{mode, modelPath}` and never downloads weights. The resident Qwen host is keyed by the canonical model directory and model type. Switching profiles replaces the loaded host; repeated generations reuse it.

## Native Qwen inference

The Rust dependency is pinned by Git revision in `rust/local-tts-bridge/Cargo.toml`. Production generation uses the low-level `TTSInference`, `AudioEncoder`, and `SpeakerEncoder` APIs.

On Apple Silicon the bridge initializes MLX's global Metal stream and runs unified Qwen tensors through that provider. On Windows it selects `Device::Gpu(0)` only when LibTorch reports CUDA available; otherwise it selects CPU. There is no alternate Qwen implementation behind the same UI.

CustomVoice splits long text at Unicode-scalar-safe sentence or clause boundaries. It never slices arbitrary UTF-8 byte positions. Each completed unit becomes a Float32 WebSocket audio chunk with 0.2 seconds of trailing silence between units.

Base mode decodes, downmixes, resamples, and caps the reference WAV, then caches encoded reference features by model, normalized WAV digest, transcript, and language. Its native streaming callback emits open-ended chunks (`total: 0`) until the final result reports `audioChunkCount`.

Rust replaces NaN/Inf samples with zero but does not peak-normalize. Renderer WAV conversion owns normalization.

## WebSocket protocol

Electron starts:

```text
open-tts-local-bridge --action serve-ws --model <qwen3|neutts> \
  --cache-dir <dir> --host 127.0.0.1 --port 0 --auth-token <token>
```

Rust prints `__PORT__<port>`, accepts only `/<token>`, enables `TCP_NODELAY`, and serves repeated requests. Requests are:

```json
{"requestId":"...","payload":{}}
{"command":"warm","requestId":"...","payload":{}}
{"command":"shutdown"}
```

For generation the bridge emits progress JSON, then an `audio_chunk` JSON frame immediately followed by exactly `sampleCount * 4` bytes of little-endian Float32 audio. One final result frame includes sample rate, model repository, timings, duration, transport marker, and chunk count. It never contains `wavBase64`.

`electron/webSocketBridgeWorker.ts` owns process lifecycle, connection retry, progress routing, inactivity monitoring, cancellation, and idle eviction. Generation is serialized per model. Cancellation terminates the bridge when a native provider call is blocking; the next request transparently starts a fresh resident process.

## NeuTTS

NeuTTS remains in the same bridge and is keyed by model repository. It accepts either pre-encoded `.npy` reference codes or a WAV clip plus its matching transcript. The first WAV reference can trigger the separate NeuCodec encoder asset download. NeuTTS produces whole-text audio, split only when transport chunk limits require it.

## Build and packaging

```bash
npm run build:rust
npm run build:desktop
npm run dist
```

`build:rust` emits exactly one executable in `dist-rust/` plus required native resources:

- macOS: MLX `mlx.metallib`, the linked GGML/llama dylibs used by NeuTTS, and their external dylib closure relinked to `@rpath`;
- Windows: the linked native bridge libraries and the LibTorch/CUDA DLL distribution closure.

No upstream Qwen executables are packaged. Model weights are never bundled.

## Verification

```bash
npm run lint
npm run test
npm run build:desktop
```

Apple Silicon release builds are verified locally by launching the packaged bridge probe and checking its Mach-O dependencies. Windows code, profiles, and packaging logic are covered by compilation/source tests; a real Windows CUDA and CPU smoke test remains required before claiming native Windows runtime validation for a release.
