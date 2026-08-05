# Electron local runtimes

Electron exposes NeuTTS Nano/Air and Qwen3-TTS through one resident compiled inference process: `open-tts-local-bridge`. Supertonic 3 runs separately in an Electron-renderer Web Worker using its official ONNX graph. Audio8 is a third, independent path: it runs `onnxruntime-node` on the CPU in a Node worker thread that Electron's main process owns, and never touches the bridge. The desktop package also contains the short-lived `open-tts-hf-xet-downloader`, used only as a scoped transport fallback for approved, revision-pinned Qwen safetensors files. It is not an inference backend. The package does not require Python or launch model-specific adapter programs. Model weights remain per-user downloads.

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
  │         └─ Windows x64: LibTorch (CPU or CUDA in custom builds)
  ├─ audio8NativeWorker (worker_threads)
  │    └─ Audio8 TTS / onnxruntime-node, CPU
  └─ open-tts-hf-xet-downloader (download-only, short-lived when needed)
```

The bridge has one backend contract regardless of platform. Platform selection happens at compile/runtime inside Rust; renderer requests never select a tensor engine, dtype, or attention implementation.

The bridge supports exactly two process actions:

- `probe`: one-shot runtime metadata.
- `serve-ws`: resident generation and warm-up server.

There is no one-shot generation action and no stdout/base64 audio fallback.

## Qwen3 profiles

In addition to CustomVoice and Base voice-clone profiles, each supported platform exposes Qwen3-TTS 1.7B VoiceDesign: MLX 6-bit revision `ffc6545dc9cb086950aa46c6cd3db490e6ece3e1` on Apple Silicon and official safetensors revision `5ecdb67327fd37bb2e042aab12ff7391903235d3` on Windows x64. VoiceDesign omits a predefined speaker token and conditions generation on the supplied natural-language voice description.

`electron/qwen3Profiles.ts` is the authoritative profile table. It contains five Apple MLX profiles and five Windows x64 LibTorch profiles: CustomVoice and Base at 0.6B and 1.7B, plus VoiceDesign at 1.7B. Every profile fixes:

- repository and immutable Hugging Face revision;
- provider and supported platform;
- model mode and parameter size;
- weight format;
- required runtime files.

The default is the platform's 0.6B CustomVoice profile: 6-bit MLX on Apple Silicon and standard safetensors with LibTorch on Windows x64. The 1.7B profiles remain explicit quality choices.

CustomVoice provides nine built-in speakers and needs no reference audio. Aiden with explicit English language conditioning is the default; the picker shows each speaker's native language, prioritizes the two English-native voices, and lets users select any other speaker without reloading the model. Base performs voice cloning and requires a WAV plus the exact reference transcript. Both accept Auto plus Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, and Italian.

## Model downloads and validation

The Electron main process owns downloads through `electron/qwen3ModelDownload.ts`.

1. Resolve only the selected profile's exact revision.
2. Select the profile's required files, plus optional files (currently `generation_config.json`) when the pinned revision ships them; leftover optional files the revision does not ship are removed.
3. Write each response to a `.download` path.
4. Validate declared length and available Hub SHA-256 metadata.
5. Atomically promote the completed file.
6. Compute local SHA-256 values and write `open-tts-model.json` last.

The manifest records the repository, revision, paths, sizes, and digests. Setup reports one of three states:

- `missing`: incomplete or wrong model type;
- `structural`: required files and model type look valid, but no matching verified manifest exists;
- `verified`: all required files match the immutable manifest, and any optional file present on disk matches it as well.

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
  "maxNewTokens": 8192
}
```

Base mode replaces speaker/instruction with `referenceAudioBase64` and `referenceText`. A multi-section job also supplies a renderer-generated `referenceCacheKey`: the first section uploads the WAV and transcript, while later sections send only that key. If the resident worker is replaced, the renderer re-seeds the new session once and retries the affected section. Backend-internal controls are intentionally absent.

Warm-up uses only `{mode, modelRepo, modelPath}` and never downloads weights. The resident Qwen host is keyed by the canonical model directory and model type. Switching profiles replaces the loaded host; repeated generations reuse it.

## Native Qwen inference

The Rust dependency is pinned by Git revision in `rust/local-tts-bridge/Cargo.toml`. Production generation uses the low-level `TTSInference`, `AudioEncoder`, and `SpeakerEncoder` APIs.

The bridge resolves hardware capabilities when the native process starts and retains that decision for the process lifetime. On Apple Silicon it queries MLX for Metal availability, initializes the matching MLX GPU or CPU stream, and passes the corresponding backend-neutral device marker. On Windows x64, `tch` 0.20 requires LibTorch 2.7.0; a CUDA-enabled custom build selects CUDA when LibTorch reports it available and otherwise selects CPU. Probe, warm-up, and generation metadata expose the compiled provider separately from the resolved device, so `mlx/metal`, `mlx/cpu`, `libtorch/cuda`, and `libtorch/cpu` cannot be confused. There is no alternate Qwen implementation behind the same UI.

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
{"command":"cancel","requestId":"..."}
{"command":"shutdown"}
```

The upgrade is refused outright when it carries an `Origin` header: only Electron's main process is a legitimate client, and it never sends one, so no browser can reach the socket even if the token leaked. Handshakes run off the accept loop (at most 8 concurrent) so a peer that connects and then goes silent cannot hold the listener for its whole handshake deadline.

For generation the bridge emits progress JSON, then an `audio_chunk` JSON frame immediately followed by exactly `sampleCount * 4` bytes of little-endian Float32 audio. Rust bounds an outgoing Float32 frame to 262,144 samples (about 1 MiB); a Qwen text unit can therefore span multiple transport frames.

All three Qwen3 modes stream audio *during* a text unit rather than emitting one buffer per unit. The talker's codes are decoded in batches of four frames and sent as they are produced, so first audio arrives after a fraction of a sentence instead of after the whole sentence — the dominant term in perceived latency. Voice cloning already worked this way; CustomVoice and VoiceDesign now share the same generate/decode tail through `generate_with_instruct_streaming`, whose conditioning is built by the same helper as the buffered API so the two cannot drift. Because a unit's 0.2 s trailing gap has to ride on that unit's *final* chunk, and which chunk is final is only known once the unit ends, the bridge holds each chunk back by one before sending it. Every streamed chunk still carries `textUnitIndex`/`textUnitTotal`, so the renderer can map audio back to sentences for highlighting. One final result frame includes sample rate, model repository, timings, duration, transport marker, and the authoritative transport-chunk count. It never contains `wavBase64`.

`electron/webSocketBridgeWorker.ts` owns process lifecycle, connection retry, progress routing, inactivity monitoring, cancellation, and idle eviction. Generation is serialized per model. Cancellation is authoritative even at the worker-acquisition/request-activation boundary.

Cancelling settles the caller immediately, then sends `{"command":"cancel"}` and lets the bridge unwind rather than killing it. Rust checks for a buffered cancel on each streamed chunk, so a Stop is observed within a few code frames and the request fails with `Generation cancelled.` through the normal result path — the process keeps the model it just loaded, and the next generation reuses it instead of paying for a reload. A worker that is still draining is awaited by the next request. The bridge only gets 20 seconds to acknowledge: if it is stuck somewhere that never reaches a checkpoint (NeuTTS inference is a single opaque call, so it can only be cancelled at its phase boundaries), the worker is killed and the next request starts a fresh resident process. Cancelling before the worker finishes spawning still kills it outright.

The transport applies bounded resource and liveness rules:

- reference uploads accept only canonical padded base64 and are capped before encoding at 65,536 bytes for NeuCodec `.npy` codes and 45,000,000 bytes for WAV audio (64 KiB and about 42.9 MiB); decoded `.npy` references must contain 1–1,000 whole-number codes in the range 0–65,535;
- a single NeuTTS or Qwen generation request accepts at most 6,000 Unicode scalar values after outer whitespace is trimmed; Studio and Reader automatically divide longer inline Qwen3 jobs into ordered, sentence-aware requests and stream them as one continuous job;
- the 500 ms renderer-request cooldown does not apply to the exact next section of the same validated job, while concurrent generation, unrelated requests, and skipped/mismatched section metadata remain limited;
- each Rust WebSocket message/frame is capped at 64 MiB, and the serialized JSON request is capped at 63 MiB so an oversize request is rejected in Electron, naming the limit, rather than tripping the server's frame-size abort;
- one request may deliver at most 256 MiB of Float32 audio, including declared inter-chunk silence, with no more than 10,000 chunks;
- a two-minute liveness watchdog is reset by Rust heartbeats or WebSocket traffic, while a 30-minute protocol-progress watchdog is reset only by WebSocket frames;
- an idle resident worker is evicted after five minutes to release model memory.

These are safety ceilings, not recommended working sizes. The IPC and Rust boundaries still reject an oversized individual request, while the Studio and Reader orchestration layers keep each local Qwen request under that ceiling automatically. If a later section fails, audio chunks attributed to that failed attempt are removed before the completed-section result is exposed, so duration and seekable playback remain consistent.

## NeuTTS

NeuTTS remains in the same bridge and is keyed by model repository. Alongside Nano, Electron exposes Air Q4 (`008555972590ff2c599dd43736ba31c81df3f0bf` at review time) and Air Q8 (`3c0f88293e3533ca0168905e75ef03be1c5aa906`) for richer English prosody. It accepts either pre-encoded `.npy` reference codes or a WAV clip plus its matching transcript, but never both in one request. WAV input is downmixed/resampled for a 16 kHz encoder window, must contain at least 0.5 seconds of speech, and is truncated to 20 seconds when longer.

## Supertonic 3

Supertonic 3 is Electron-only even though it uses a renderer worker. The desktop entry is the only entry that imports that worker; the web app neither lists nor initializes it. Assets come from `Supertone/supertonic-3` revision `3cadd1ee6394adea1bd021217a0e650ede09a323`, are cached after first use, and run through WebGPU with a WASM fallback. The runtime exposes ten preset styles, 31 languages, and the model's `<laugh>`, `<breath>`, and `<sigh>` expression tags.

The first WAV reference can trigger a one-time NeuCodec RTen encoder download of about 1.8 GB. Open TTS pins Hugging Face revision `836c82069dba26eaab204a2df951b19facf777e1` and verifies the 1,772,018,304-byte artifact against SHA-256 `155574ffc88ca5f86f0f0849ac2f75ce9b197fc205598698eb5b366081e68d7c` before use. The default file lives under the NeuTTS cache at `neucodec-encoder/neucodec_encoder_v2.rten`; a custom local file can be supplied to development builds with `OPEN_TTS_NEUCODEC_ENCODER=/absolute/path/to/neucodec_encoder_v2.rten`. The encoder is retained in the resident process after loading. Supplying pre-encoded `.npy` codes avoids this download. NeuTTS produces whole-text audio, split only when transport chunk limits require it.

## Audio8

Audio8 TTS Preview 0.6B ONNX INT4 is the one desktop model that runs neither in the bridge nor in the renderer. `electron/audio8NativeWorker.ts` executes its three graphs on `onnxruntime-node` inside a `worker_threads` worker, and Electron's main process owns exactly one such worker for the whole app. The inference procedure itself — prompt layout, the two-stage slow/fast sampling loop, the KV-cache update scheme, and the codec decode — is adapted from Audio8's Apache-2.0 reference runtime.

`electron/audio8Model.ts` is the single source of truth: the pinned model revision `818569c6b832118ad68d61bbd873abe250fcd68a`, the separate voice-Space revision `6417ebaafc996620bebc3eb27cde0d5acb19f13b`, the asset table with per-file sizes and digests, the six voice ids, and the 1,000-character request cap all live there. The main process (cache location, IPC validation, cache reporting) and the worker (downloads, verification, synthesis) both read that table, so a revision bump is one edit and the cache directory cannot end up pointing at one revision while the download targets another.

### Worker protocol

The worker is spawned on the first request with `workerData.modelDir` set to the revision cache directory, and is reused from then on. Five IPC channels stand in front of it:

```text
audio8:load          start (or join) the model load; streams audio8:progress
audio8:generate      synthesize one chunk of text in one voice
audio8:cancel        stop an in-flight request by id
audio8:cache-info    path, existence, and size of the audio8 namespace
audio8:clear-cache   stop the worker, then remove every revision
```

Every payload is validated in the main process before it reaches the worker: request ids must match `^[a-zA-Z0-9._-]{1,128}$`, text must be non-empty and at most 1,000 Unicode scalar values, and an unknown voice is rejected rather than replaced with the default — quietly rendering a whole request in a voice the caller did not ask for is a wrong answer with nothing to show it. The worker re-checks the text and the voice itself, and rejects an unknown voice in the same wording, so the two boundaries cannot disagree about what a valid request is.

Messages are `load`, `generate`, and `cancel` in, `progress`, `result`, and `error` out, all keyed by request id. Progress is delivered only to the request that produced it, so one window's download percentages cannot land in another window's progress bar. Downloads own the first 90% of a load, and the remaining steps (92, 95, 97, 100) mark off the three ONNX sessions, whose durations are fixed enough that stepped values read better than a synthetic ramp. `generate` returns the sample rate, the elapsed time, and one transferred `ArrayBuffer` of Float32 PCM; there is no chunk stream, so the renderer splits text into 180-character chunks and schedules each returned buffer itself.

A request that goes five minutes without any message from the worker fails and takes the worker with it: a thread stuck inside a native ONNX call cannot be talked out of it and still holds its sessions, so it is replaced and the next request starts clean. A worker that exits or errors rejects everything waiting on it, and the next request spawns a fresh one — which is what makes the renderer's retry button work. The worker is `unref`ed so it cannot keep a closing app alive. `destroy()` is final: the client latches closed and every later request rejects, which is what lets the clear-cache path drop its reference and await the shutdown without a racing request resurrecting a worker that would map the graphs again mid-unlink.

### Inference

A slow autoregressive transformer emits one semantic token and a hidden state per frame; a fast transformer expands that hidden state into the remaining acoustic codebooks; a codec decoder turns the finished code matrix into 44.1 kHz mono Float32 PCM. Sequence lengths, layer and head counts, codebook size, and token ids are read from the model's own `runtime_manifest.json` rather than hard-coded, so the graphs and the driver cannot drift apart. The prompt is a `(codebooks + 1, length)` matrix: row 0 carries text tokens and the voice's semantic codes, the remaining rows carry that voice's acoustic codes under the same positions. The token budget for a request is `min(512, max(64, characters × 2.5), maxSeqLen − promptLength)`.

Sampling is top-k, then nucleus, then temperature, and the sampler is seeded, so one text, voice, and revision reproduce the same audio — that reproducibility is what makes a regression in this loop detectable at all. A semantic token the model has just produced is re-rolled once at a higher temperature, which is what stops generation settling into a repeated syllable.

Intra-op threads are chosen at session creation by `electron/audio8Threading.ts`: up to four Apple performance cores on arm64 macOS, because scheduling across efficiency cores hurts latency and the memory-bandwidth-bound INT4 graphs benchmark faster at four threads than at five or six on a six-performance-core M1 Pro. Smaller M-series chips automatically use their available count. Other platforms use `min(6, availableParallelism())`, because the graphs stop scaling well before a large machine runs out of cores and the desktop app still has a UI to keep responsive.

### Assets and integrity

A cold load fetches eight files totalling 599,933,441 bytes (572.1 MiB) from the pinned model revision: `slow_ar_int4.onnx`, `fast_ar_int4.onnx`, and `codec_decoder_fp16.onnx` with their external `.data` weights, plus `tokenizer/tokenizer.json` and `runtime_manifest.json`. The repository's `registration/` encoder — 395 MiB of weights used to register new voices — is deliberately absent from the table: Open TTS ships pre-registered voice profiles and never registers a voice on the device, so downloading it would cost most of a gigabyte for a capability the app does not expose.

Voice profiles are published from the Space of the same name rather than the model repository, and are pinned to their own revision. Each is a `codes.npy` matrix plus a `meta.json` carrying the reference text; all six together are under 13 KiB, and each is fetched the first time its voice is used.

Every file is verified against its exact byte length and then a digest before it is used. Both digest algorithms appear in the table because the Hub serves the two kinds of file differently: LFS files expose an upstream SHA-256, while small text files are addressable only by their git blob SHA-1 (`sha1("blob <size>\0" + content)`). Verification is streamed in 1 MiB reads and happens once per file per process; hashing the full 572 MiB costs well under a second against a load that spends seconds building ONNX sessions. Files are downloaded one at a time in table order, so a cold start does not open eight connections at once and progress stays monotonic, and each is written to a `.partial` path that is renamed only after both checks pass. A `.partial` from an interrupted run is deleted rather than appended to, because the transfer has no resume support. Transfers use the same HTTPS reader as the Qwen downloader, which refuses non-HTTPS URLs and non-Hugging Face hosts. A transfer that produces no bytes for two minutes is treated as wedged; there is deliberately no cap on total duration, because the largest single asset is 277 MiB and a slow connection has to be allowed to take as long as it needs.

### Single-flight and cancellation

`electron/audio8SharedTask.ts` provides a reference-counted single-flight used for the model load (`SharedTask`) and for per-file downloads (`SharedTaskGroup`, keyed by file). Guarding only the finished state is not enough: the renderer re-issues `load` on React StrictMode's double effect, on model toggles, and from its retry button, and two concurrent loads would fetch the same 572 MiB into the same `.partial` path, interleaving chunks into corrupt bytes. Progress fans out to every participant, and the shared work is abandoned only once the last participant has given up, so one window pressing Stop cannot cancel a transfer another window is still waiting on.

Stopping a generation sends `audio8:cancel`, which reports honestly whether there was anything to stop: `false` covers a request that had already settled, a worker that is gone, and an id that was never issued. The worker checks the abort signal at every token step of the sampling loop, and downloads check it between chunks, so a Stop is observed without waiting for the whole request. A model load is deliberately *not* cancelled when the user switches away from Audio8 or closes the page — the download is shared process-wide and abandoning it part way would throw away everything already fetched — but it keeps reporting into renderer state either way, so a load that fails while Audio8 is deselected still surfaces its error instead of leaving the runtime stuck on "loading".

The on-disk cache, its revision scoping, pruning, and the ordering that clearing requires are described in [Local persistence](./storage.md#audio8-model-cache).

## Platform support

| Platform | Qwen3 status | Provider |
|---|---|---|
| macOS 26+ on Apple Silicon (`arm64`) | Supported and locally verified | MLX; Metal when available, CPU fallback otherwise |
| Windows x64 | Experimental custom builds only; no Windows package is attached to GitHub Releases | LibTorch 2.7.0 via `tch` 0.20 |
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
- Windows x64: the linked native bridge libraries and the selected LibTorch 2.7.0 DLL set from `LIBTORCH`; Windows packages are custom-build outputs only.

No upstream Qwen inference executables are packaged. Model weights are never bundled.

`onnxruntime-node` ships as a native module, so it is unpacked from the asar archive and pruned to the target platform: the macOS build drops the Windows binaries, the Windows build drops the macOS binaries and every Windows architecture but the one being built, and both drop Linux. That is 74 MB on macOS arm64 and 61 MB on Windows x64, against 258 MB for the full set.

## Verification

```bash
npm run lint
npm run test
npm run build:desktop
```

Tagged releases publish source archives only. Maintainers can build unsigned
Apple Silicon macOS packages locally with `npm run dist:mac`; the build scripts
still verify and bundle the native bridge dependencies. Windows CPU/CUDA
packages also remain custom-build outputs and are not attached to GitHub
Releases.

## Troubleshooting

- **Bridge executable missing or not executable:** run `npm run build:rust`, then retry `npm run build:desktop`. A packaged app must contain both Rust executables under `dist-rust/`.
- **Qwen is unavailable:** confirm the host is Apple Silicon macOS or Windows x64. Intel macOS, Windows on Arm, and Linux intentionally have no packaged Qwen provider.
- **Qwen model is incomplete or incompatible:** use **Repair / re-download** for the selected profile. A manually selected directory can be structurally valid without being revision-verified; it must still match that profile's `tts_model_type` and required files.
- **Windows build rejects LibTorch:** point `LIBTORCH` at a release LibTorch 2.7.0 distribution compatible with `tch` 0.20. Do not mix debug and release libraries. Windows support remains experimental until the native release gates above pass.
- **NeuCodec download or load failed:** ensure roughly 1.8 GB can be downloaded and stored, then remove the incomplete `neucodec-encoder/neucodec_encoder_v2.rten` cache file and retry. For a pre-provisioned model, set `OPEN_TTS_NEUCODEC_ENCODER` to an existing absolute file path.
- **Reference upload rejected:** use a WAV for audio or a NumPy `.npy` file for NeuCodec codes, include the exact matching transcript, and stay below the upload ceilings above. Qwen Base accepts WAV only; Qwen CustomVoice accepts neither reference field.
- **Studio or Reader text is too long for Qwen:** inline Qwen automatically creates sentence-aware requests of at most 6,000 characters. If a section still fails, retry it after reducing unusually long unbroken text.
- **No output / protocol-progress timeout:** inspect the surfaced bridge diagnostics. Heartbeats prevent false two-minute liveness failures during native work, but 30 minutes without any WebSocket protocol frame is treated as a stuck request and the worker is replaced.
- **Audio8 reports a failed integrity verification:** the file on disk does not match its pinned length and digest, so it is refused rather than loaded. The partial file is already removed; retry the load, and if it keeps failing, use **Clear Local Cache** in Audio8's model settings and download again.
- **Audio8 stops with "download stalled":** a transfer produced no bytes for two minutes. Total duration is not capped, so this is a wedged connection rather than a slow one; retry the load, which resumes from the files already verified on disk.
- **Authentication failure in manual bridge testing:** supply a non-empty `OPEN_TTS_WS_AUTH_TOKEN` and connect to `ws://127.0.0.1:<announced-port>/<the-same-token>`. Electron creates this value automatically; do not persist it.
