# Open TTS qwen3-tts-rs vendor notes

This directory is a source snapshot, not a live Git checkout or submodule.

- `badlogic/qwen3_tts_rs`: `288a716ce38a91c826dd67968c75d1dd4b0f07bc`
  (crate version 0.2.2)
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
  paths.

The upstream high-level VoiceDesign API at the pinned revision returns
placeholder silence; the rest of the low-level inference engine remains the
native backend used by Open TTS.

The patch also refreshes the source-compatible `tokenizers`, `base64`, and
`tower-http` dependency majors, and pins `base64` to `default-features = false`
with only `std` so 0.23's default `simd-unsafe` engines stay out of the build;
native/audio-coupled dependencies remain at their pinned versions. Only the
`tokenizers` and `base64` bumps are verified here: both are used by the crate
library, which Open TTS compiles through the vendored MLX backend and covers
with the bridge suite. `tower-http` has no consumer outside
`src/bin/api_server.rs`, and Open TTS depends on this crate as a library only,
so nothing in this repository builds that binary — the `tower-http` bump is
unverified and must be re-checked against upstream on the next re-vendor.

## Inference compatibility fixes

The local inference patch now applies Qwen's reserved-code mask and minimum
EOS length, applies repetition penalties once per distinct token, and uses the
upstream language/speaker prefix for Auto and explicit languages. Instruction
prefixes use projected text without codec padding; 0.6B CustomVoice ignores
instructions as the official wrapper does. Regression tests cover codec logits,
prefix token layouts, and the small-model instruction capability.

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
   the on-device repetition penalty in `predict_code_0`, and the bundled mlx-c
   error message still match the new upstream APIs.
6. Update both pinned revisions, refresh `OPEN_TTS.patch`, and update the
   expected vendor digest in `electron/qwen3Vendor.test.ts` in the same change.
7. Run `npx vitest run electron/qwen3Vendor.test.ts`, then the Rust bridge tests
   on Apple Silicon and Windows x64. An Apple Silicon release build must also
   contain the expected `mlx.metallib` next to the bridge binary.

The guard deliberately hashes the exported source plus the applied Open TTS
patch while excluding this note, the patch file itself, and Cargo's
`.cargo-ok` marker. Any vendor drift therefore requires an explicit pin,
patch, and digest review.
