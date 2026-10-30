# Open TTS qwen3-tts-rs vendor notes

This directory is a source snapshot, not a live Git checkout or submodule.

- `badlogic/qwen3_tts_rs`: `288a716ce38a91c826dd67968c75d1dd4b0f07bc`
  (crate version 0.2.2), Mario Zechner's MLX fork of
  `second-state/qwen3_tts_rs` by Michael Yuan. The fork adds the quantized MLX
  layers that the `mlx-community` 6-bit profiles need.
- nested `badlogic/mlx-c`: `22a304206cbc77a5f74d0e0eb7363f2a6998d74f`

Open TTS carries a patch in `OPEN_TTS.patch`. It:

- adds the low-level VoiceDesign prompt construction used by the resident
  bridge, keeps VoiceDesign request details off stdout, changes MLX build
  guidance to match this bundled source tree, and corrects the
  generation-config filename in `src/model.rs` to `generation_config.json`
  (upstream reads the nonexistent `generate_config.json`);
- aligns CLI/worker defaults with the model's 8,192-token generation
  configuration and rejects budget exhaustion without an end-of-speech token
  instead of returning truncated audio as a successful completion;
- exposes a bounded streaming twin of the instruct path used by CustomVoice
  and VoiceDesign, sharing prompt construction with the buffered API and
  decoding completed code batches incrementally. Both streaming paths skip a
  batch that decodes to no samples — that is vocoder lookahead state rather
  than audio — and the per-batch decode is silent, because it runs many times
  per request against the bridge's bounded stdout buffer;
- makes `build_input_embeddings` take an optional language id and emit the
  no-think codec prefix when it is absent, so CustomVoice "Auto" matches the
  reference implementation instead of placing raw codec code 0 in the prompt
  (`generate_with_xvector` keeps upstream's fallback because Open TTS does not
  call it);
- rejects an unknown CustomVoice speaker as an error rather than silently
  falling back to speaker id 0;
- loads `generation_config.json` into `TTSInference` and passes its
  repetition penalty to the streaming talker through
  `generate_codes_streaming_with_penalty` (the upstream
  `generate_codes_streaming` signature is preserved and delegates with the
  default), and applies that penalty on the device instead of copying the
  logits to the host every frame;
- names the vocoder output rate once (`OUTPUT_SAMPLE_RATE`) for the streaming
  paths;
- takes the top-k sampling threshold as the minimum of the top-k values
  (`Tensor::amin_dim`, backed by a new `mlx_min_axis` binding) in both the
  talker and the code predictor. Upstream read index `k - 1`, which assumes
  sorted values, but MLX's `topk` returns them in partition order, so the
  threshold could be the largest logit: sampling then kept one candidate and
  every seed decoded the same, effectively greedy, output;
- warms the streaming vocoder state in `generate_with_icl_streaming` by
  decoding the last 25 reference codec frames (`ICL_VOCODER_LEFT_CONTEXT_FRAMES`,
  the official `chunked_decode` `left_context_size`) and discarding the
  samples, so each voice-clone unit's first audio is decoded with the reference
  voice's acoustic context instead of a cold state;
- puts the HTTP API and the command-line binaries behind the `api` and `cli`
  features (see "Optional HTTP API and binaries" below).

The upstream high-level VoiceDesign API at the pinned revision returns
placeholder silence; the rest of the low-level inference engine remains the
native backend used by Open TTS.

The patch also refreshes the source-compatible `tokenizers`, `base64`, and
`tower-http` dependency majors, and pins `base64` to `default-features = false`
with only `std` so 0.23's default `simd-unsafe` engines stay out of the build.
`tokenizers` also drops its default `esaxx_fast` feature (keeping `onig` and
`progressbar`): `esaxx-rs` builds its C++ with the static MSVC runtime (`/MT`,
hard-coded in its build script), and MSVC refuses to link it into a bridge
whose LibTorch and llama.cpp use the dynamic one (`/MD`, LNK2038). The feature
only speeds up Unigram training; without it `tokenizers` uses its pure-Rust
suffix array, and inference never reaches either;
native/audio-coupled dependencies remain at their pinned versions. Only the
`tokenizers` and `base64` bumps are verified here: both are used by the crate
library, which Open TTS compiles through the vendored MLX backend and covers
with the bridge suite. `tower-http` has no consumer outside
`src/bin/api_server.rs`, and Open TTS depends on this crate as a library only,
so nothing in this repository builds that binary. When the `api` and `cli`
features were added, `cargo check --all-targets` with the default features
against LibTorch 2.7.0 compiled it, but CI does not repeat that check, so
re-check the `tower-http` bump on the next re-vendor.

## Inference compatibility fixes

The local inference patch now applies Qwen's reserved-code mask and minimum
EOS length, applies repetition penalties once per distinct token, and uses the
upstream language/speaker prefix for Auto and explicit languages. Instruction
prefixes use projected text without codec padding; 0.6B CustomVoice ignores
instructions as the official wrapper does. Speakers flagged in the config's
`spk_is_dialect` (Dylan and Eric) use their dialect's codec language token
when the request is Chinese or Auto, matching upstream; an unknown dialect
falls back to the requested language. Regression tests cover codec logits,
prefix token layouts, the dialect override, and the small-model instruction
capability.

## Optional HTTP API and binaries

Upstream compiles its HTTP API (`qwen3_tts_rs::api`) and the stack behind it
into the library unconditionally: `axum`, `tokio`, `tower-http`,
`tracing-subscriber`, `clap`, and the MP3, FLAC, and Opus encoders, two of
which build C libraries. The bridge uses none of it. The patch makes those
dependencies optional behind two features:

- `api` gates the `api` module and its encoders;
- `cli` enables `api` plus what the binaries need, and every `[[bin]]`
  requires it. `src/bin/trace_rust.rs`, which upstream builds by
  auto-discovery, gets an explicit `[[bin]]` entry so it can require `cli`.

`default` includes `cli`, so a plain `cargo build` of this crate behaves as
upstream does. The bridge already sets `default-features = false`, so it
compiles the library alone.

## Seeded sampling

`tensor::set_sampling_seed` makes sampling reproducible. On MLX, which upstream
seeds from the clock on every categorical draw, a seed turns the per-draw PRNG
key into the seed plus a draw counter; `None` restores clock seeding. On
LibTorch it calls `tch::manual_seed`. The bridge reseeds before every text unit
when a request carries a seed.

The `qwen3-tts` CLI's `--seed`, which upstream accepts but ignores with a
warning, now calls it once, just before generation, so model and reference
loading cannot shift the draw sequence. Without `--seed` the CLI samples as
upstream does. `pibot-tts-worker` still ignores its `--seed`. Open TTS builds
neither binary, so no Open TTS test covers this change.

## LibTorch dtypes

The fork keeps `text_embedding` in the checkpoint's bf16 and rounds several
talker inputs to bf16 to match Python MLX numerics, while LibTorch `Linear`
weights are converted to f32. LibTorch's `matmul` does not promote mixed
dtypes, so every Qwen3 mode on the LibTorch backend failed with
`BFloat16 != float` before producing audio. On LibTorch only, `Linear::forward`
now casts its input to the weight's dtype. The MLX path is unchanged. With the
pinned official checkpoints on LibTorch CPU, CustomVoice 0.6B, Base 0.6B voice
cloning, and VoiceDesign 1.7B all produced speech through the bridge's
streaming calls, and the same seed reproduced the same audio.

## Regenerating the patch

`rust/qwen3_tts_rs` (git-ignored) is a checkout of the pinned upstream
revision; use its `HEAD`, not its working tree, which may hold local
experiments. Export it with `git archive HEAD` into a temporary directory,
commit that as a baseline in a throwaway repository, copy in the patched
vendor files, and take `git diff` of each patched path. Keep the file order of
the existing patch, and check the result with
`npx vitest run electron/qwen3Vendor.test.ts`, which reverse- and
forward-applies it.

## Re-vendor checklist

1. Start from a clean Open TTS worktree and create a temporary checkout outside
   `rust/vendor`. Check out the exact qwen3-tts-rs revision above, then run its
   `git submodule update --init --recursive` once in that temporary checkout.
2. Verify `git rev-parse HEAD` in the temporary qwen3-tts-rs checkout and
   `git -C mlx-c rev-parse HEAD` match both full revisions above. Also verify
   both checkouts have no tracked or untracked source changes.
3. Export each checkout with `git archive` into a fresh
   `rust/vendor/qwen3-tts-rs` tree. Export mlx-c separately into its `mlx-c/`
   directory because the parent records it as a gitlink. Do not copy `.git`,
   `.cargo-ok`, build output, model weights, or generated audio.
4. Preserve this file and `OPEN_TTS.patch`, then apply the patch from the new
   vendor root with `git apply --check OPEN_TTS.patch` followed by
   `git apply OPEN_TTS.patch`.
5. Review the patch rather than resolving failures mechanically. In particular,
   confirm `build_input_embeddings` (optional language),
   `build_voice_design_input_embeddings`, the shared instruct prompt,
   `generate_with_instruct_streaming`, `generate_codes_streaming_with_penalty`,
   the on-device repetition penalty in `predict_code_0`, the LibTorch input
   cast in `Linear::forward`, and the bundled mlx-c error message still match
   the new upstream APIs. Also check that every new upstream dependency used
   only by `src/api` or `src/bin` is optional and listed in `api` or `cli`, and
   that every new binary requires `cli`.
6. Update both pinned revisions, refresh `OPEN_TTS.patch`, and update the
   expected vendor digest in `electron/qwen3Vendor.test.ts` in the same change.
7. Run `npx vitest run electron/qwen3Vendor.test.ts`, then the Rust bridge tests
   on Apple Silicon and Windows x64. An Apple Silicon release build must also
   contain the expected `mlx.metallib` next to the bridge binary.

The guard deliberately hashes the exported source plus the applied Open TTS
patch while excluding this note, the patch file itself, and Cargo's
`.cargo-ok` marker. Any vendor drift therefore requires an explicit pin,
patch, and digest review.
