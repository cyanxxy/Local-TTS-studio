# Electron local runtimes

Electron exposes NeuTTS Nano/Air and Qwen3-TTS through one resident compiled inference process: `open-tts-local-bridge`. Supertonic 3 runs separately in an Electron-renderer Web Worker using its official ONNX graph. The desktop package also contains the short-lived `open-tts-hf-xet-downloader`, used only as a scoped transport fallback for approved, revision-pinned Qwen safetensors files. It is not an inference backend. The package does not require Python or launch model-specific adapter programs. Model weights remain per-user downloads.

## Architecture

```text
React renderer
  │ trusted Electron IPC
  ▼
Electron main process
  ├─ authenticated ws://127.0.0.1:<port>/<token>
  │    ▼
  │  open-tts-local-bridge (resident Rust process)
  │    ├─ NeuTTS / GGUF
  │    └─ Qwen3-TTS / pinned qwen3-tts-rs
  │         ├─ Apple Silicon: MLX + Metal
  │         └─ Windows x64: LibTorch (CPU in GitHub releases; CUDA in custom builds)
  └─ open-tts-hf-xet-downloader (download-only, short-lived when needed)
```

Electron has one backend contract regardless of platform. Platform selection happens at compile/runtime inside Rust; renderer requests never select a tensor engine, dtype, or attention implementation.

The bridge supports exactly two process actions:

- `probe`: one-shot runtime metadata.
- `serve-ws`: resident generation and warm-up server.

There is no one-shot generation action and no stdout/base64 audio fallback.

## Qwen3 profiles

In addition to CustomVoice and Base voice-clone profiles, each supported platform exposes Qwen3-TTS 1.7B VoiceDesign: MLX 6-bit revision `ffc6545dc9cb086950aa46c6cd3db490e6ece3e1` on Apple Silicon and official safetensors revision `5ecdb67327fd37bb2e042aab12ff7391903235d3` on Windows x64. VoiceDesign omits a predefined speaker token and conditions generation on the supplied natural-language voice description.

`electron/qwen3Profiles.ts` is the authoritative profile table. It contains four Apple MLX profiles and four Windows x64 LibTorch profiles: CustomVoice and Base, each at 0.6B and 1.7B. Every profile fixes:

- repository and immutable Hugging Face revision;
- provider and supported platform;
- model mode and parameter size;
- weight format;
- required runtime files.

The default is the platform's 0.6B CustomVoice profile: 6-bit MLX on Apple Silicon and standard safetensors with LibTorch on Windows x64. The 1.7B profiles remain explicit quality choices.

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

Base mode replaces speaker/instruction with `referenceAudioBase64` and `referenceText`. A multi-section job also supplies a renderer-generated `referenceCacheKey`: the first section uploads the WAV and transcript, while later sections send only that key. If the resident worker is replaced, the renderer re-seeds the new session once and retries the affected section. Backend-internal controls are intentionally absent.

Warm-up uses only `{mode, modelRepo, modelPath}` and never downloads weights. The resident Qwen host is keyed by the canonical model directory and model type. Switching profiles replaces the loaded host; repeated generations reuse it.

## Native Qwen inference

The Rust dependency is pinned by Git revision in `rust/local-tts-bridge/Cargo.toml`. Production generation uses the low-level `TTSInference`, `AudioEncoder`, and `SpeakerEncoder` APIs.

The bridge resolves hardware capabilities when the native process starts and retains that decision for the process lifetime. On Apple Silicon it queries MLX for Metal availability, initializes the matching MLX GPU or CPU stream, and passes the corresponding backend-neutral device marker. On Windows x64, `tch` 0.20 requires LibTorch 2.7.0; a CUDA-enabled custom build selects CUDA when LibTorch reports it available and otherwise selects CPU. The GitHub Release installer uses CPU-only LibTorch because the official CUDA archive is larger than GitHub's per-asset release limit. Probe, warm-up, and generation metadata expose the compiled provider separately from the resolved device, so `mlx/metal`, `mlx/cpu`, `libtorch/cuda`, and `libtorch/cpu` cannot be confused. There is no alternate Qwen implementation behind the same UI.

CustomVoice splits accepted text at Unicode-scalar-safe sentence or clause boundaries. It never slices arbitrary UTF-8 byte positions. Each completed text unit is streamed through one or more bounded Float32 transport chunks; repeated `textUnitIndex`/`textUnitTotal` metadata keeps those chunks associated with the source unit, and 0.2 seconds of inter-unit silence is declared only on that unit's final transport chunk.

Base mode decodes, downmixes, resamples, and caps the reference WAV at 20 seconds, then caches encoded reference features by model, normalized WAV digest, transcript, and language. A bounded per-host cache can additionally bind those prepared features to a session key, avoiding repeated base64 IPC/WebSocket uploads and repeated native reference validation across one long job. When a longer clip is supplied, generation continues with the first 20 seconds and returns a truncation warning. Its native streaming callback emits open-ended chunks (`total: 0`) until the final result reports `audioChunkCount`.

Rust replaces NaN/Inf samples with zero but does not peak-normalize. Renderer WAV conversion owns normalization.

## WebSocket protocol

Electron starts the process with a per-process environment secret (shown here as a shell-style illustration; the app sets it programmatically):

```text
OPEN_TTS_WS_AUTH_TOKEN=<token> open-tts-local-bridge \
  --action serve-ws --model <qwen3|neutts> \
  --cache-dir <dir> --host 127.0.0.1 --port 0
```

Rust resolves the configured host once and refuses to start unless every bind address is loopback; it also verifies the bound listener is loopback. It then prints `__PORT__<port>`, accepts only `/<token>`, enables `TCP_NODELAY`, and serves repeated requests. Requests are:

```json
{"requestId":"...","payload":{}}
{"command":"warm","requestId":"...","payload":{}}
{"command":"shutdown"}
```

For generation the bridge emits progress JSON, then an `audio_chunk` JSON frame immediately followed by exactly `sampleCount * 4` bytes of little-endian Float32 audio. Rust bounds an outgoing Float32 frame to 262,144 samples (about 1 MiB); a Qwen text unit can therefore span multiple transport frames. One final result frame includes sample rate, model repository, timings, duration, transport marker, and the authoritative transport-chunk count. It never contains `wavBase64`.

`electron/webSocketBridgeWorker.ts` owns process lifecycle, connection retry, progress routing, inactivity monitoring, cancellation, and idle eviction. Generation is serialized per model. Cancellation is authoritative even at the worker-acquisition/request-activation boundary, and terminates the bridge when a native provider call is blocking; the next request transparently starts a fresh resident process.

The transport applies bounded resource and liveness rules:

- reference uploads accept only canonical padded base64 and are capped before encoding at 65,536 bytes for NeuCodec `.npy` codes and 45,000,000 bytes for WAV audio (64 KiB and about 42.9 MiB); decoded `.npy` references must contain 1–1,000 whole-number codes in the range 0–65,535;
- a single NeuTTS or Qwen generation request accepts at most 6,000 Unicode scalar values after outer whitespace is trimmed; Studio and Reader automatically divide longer inline Qwen3 jobs into ordered, sentence-aware requests and stream them as one continuous job;
- the 500 ms renderer-request cooldown does not apply to the exact next section of the same validated job, while concurrent generation, unrelated requests, and skipped/mismatched section metadata remain limited;
- the serialized JSON request and each Rust WebSocket message/frame are capped at 64 MiB;
- one request may deliver at most 256 MiB of Float32 audio, including declared inter-chunk silence, with no more than 10,000 chunks;
- a two-minute liveness watchdog is reset by Rust heartbeats or WebSocket traffic, while a 30-minute protocol-progress watchdog is reset only by WebSocket frames;
- an idle resident worker is evicted after five minutes to release model memory.

These are safety ceilings, not recommended working sizes. The IPC and Rust boundaries still reject an oversized individual request, while the Studio and Reader orchestration layers keep each local Qwen request under that ceiling automatically. If a later section fails, audio chunks attributed to that failed attempt are removed before the completed-section result is exposed, so duration and seekable playback remain consistent.

## NeuTTS

NeuTTS remains in the same bridge and is keyed by model repository. Alongside Nano, Electron exposes Air Q4 (`008555972590ff2c599dd43736ba31c81df3f0bf` at review time) and Air Q8 (`3c0f88293e3533ca0168905e75ef03be1c5aa906`) for richer English prosody. It accepts either pre-encoded `.npy` reference codes or a WAV clip plus its matching transcript, but never both in one request. WAV input is downmixed/resampled for a 16 kHz encoder window, must contain at least 0.5 seconds of speech, and is truncated to 20 seconds when longer.

## Supertonic 3

Supertonic 3 is Electron-only even though it uses a renderer worker. The desktop entry is the only entry that imports that worker; the web app neither lists nor initializes it. Assets come from `Supertone/supertonic-3` revision `3cadd1ee6394adea1bd021217a0e650ede09a323`, are cached after first use, and run through WebGPU with a WASM fallback. The runtime exposes ten preset styles, 31 languages, and the model's `<laugh>`, `<breath>`, and `<sigh>` expression tags.

The first WAV reference can trigger a one-time NeuCodec RTen encoder download of about 1.8 GB. Open TTS pins Hugging Face revision `836c82069dba26eaab204a2df951b19facf777e1` and verifies the 1,772,018,304-byte artifact against SHA-256 `155574ffc88ca5f86f0f0849ac2f75ce9b197fc205598698eb5b366081e68d7c` before use. The default file lives under the NeuTTS cache at `neucodec-encoder/neucodec_encoder_v2.rten`; a custom local file can be supplied to development builds with `OPEN_TTS_NEUCODEC_ENCODER=/absolute/path/to/neucodec_encoder_v2.rten`. The encoder is retained in the resident process after loading. Supplying pre-encoded `.npy` codes avoids this download. NeuTTS produces whole-text audio, split only when transport chunk limits require it.

## Platform support

| Platform | Qwen3 status | Provider |
|---|---|---|
| macOS 26+ on Apple Silicon (`arm64`) | Supported and locally verified | MLX; Metal when available, CPU fallback otherwise |
| Windows x64 | Experimental; GitHub installer is CPU-only; native CPU generation and clean-VM validation remain release gates | LibTorch 2.7.0 via `tch` 0.20 |
| Intel macOS, Windows on Arm, and Linux | Unavailable | No packaged Qwen provider |

Kokoro remains available in Electron when Qwen3 is unavailable. The legacy Supertonic 2 browser runtime is intentionally omitted from Electron and replaced by Supertonic 3; NeuTTS is independent of the Qwen provider matrix.

## Build and packaging

```bash
npm run build:rust
npm run build:desktop
npm run dist
```

`build:rust` emits two executables in `dist-rust/`: the resident bridge and the scoped Xet downloader, plus required native resources:

- macOS: MLX `mlx.metallib`, the linked GGML/llama dylibs used by NeuTTS, and their external dylib closure relinked to `@rpath`;
- Windows x64: the linked native bridge libraries and the selected LibTorch 2.7.0 DLL set from `LIBTORCH`; tagged GitHub releases use the CPU distribution.

No upstream Qwen inference executables are packaged. Model weights are never bundled.

## Verification

```bash
npm run lint
npm run test
npm run build:desktop
```

The tagged-release workflow builds on native Apple Silicon macOS 26 and Windows x64 runners. It verifies signatures, notarization, portable Mach-O dependencies, deployment targets, and packaged bridge probes before publishing. Real Windows CPU generation and a clean-VM install remain required before removing the experimental label; CUDA generation applies to separately built CUDA packages and is not claimed by the GitHub installer.

## Troubleshooting

- **Bridge executable missing or not executable:** run `npm run build:rust`, then retry `npm run build:desktop`. A packaged app must contain both Rust executables under `dist-rust/`.
- **Qwen is unavailable:** confirm the host is Apple Silicon macOS or Windows x64. Intel macOS, Windows on Arm, and Linux intentionally have no packaged Qwen provider.
- **Qwen model is incomplete or incompatible:** use **Repair / re-download** for the selected profile. A manually selected directory can be structurally valid without being revision-verified; it must still match that profile's `tts_model_type` and required files.
- **Windows build rejects LibTorch:** point `LIBTORCH` at a release LibTorch 2.7.0 distribution compatible with `tch` 0.20. Do not mix debug and release libraries. Windows support remains experimental until the native release gates above pass.
- **NeuCodec download or load failed:** ensure roughly 1.8 GB can be downloaded and stored, then remove the incomplete `neucodec-encoder/neucodec_encoder_v2.rten` cache file and retry. For a pre-provisioned model, set `OPEN_TTS_NEUCODEC_ENCODER` to an existing absolute file path.
- **Reference upload rejected:** use a WAV for audio or a NumPy `.npy` file for NeuCodec codes, include the exact matching transcript, and stay below the upload ceilings above. Qwen Base accepts WAV only; Qwen CustomVoice accepts neither reference field.
- **Studio or Reader text is too long for Qwen:** inline Qwen automatically creates sentence-aware requests of at most 6,000 characters. If a section still fails, retry it after reducing unusually long unbroken text.
- **No output / protocol-progress timeout:** inspect the surfaced bridge diagnostics. Heartbeats prevent false two-minute liveness failures during native work, but 30 minutes without any WebSocket protocol frame is treated as a stuck request and the worker is replaced.
- **Authentication failure in manual bridge testing:** supply a non-empty `OPEN_TTS_WS_AUTH_TOKEN` and connect to `ws://127.0.0.1:<announced-port>/<the-same-token>`. Electron creates this value automatically; do not persist it.
