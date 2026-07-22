# Open TTS qwen3-tts-rs vendor notes

This directory is a source snapshot, not a live Git checkout or submodule.

- `badlogic/qwen3_tts_rs`: `288a716ce38a91c826dd67968c75d1dd4b0f07bc`
  (crate version 0.2.2)
- nested `badlogic/mlx-c`: `22a304206cbc77a5f74d0e0eb7363f2a6998d74f`

Open TTS carries a small patch in `OPEN_TTS.patch`. It adds the low-level
VoiceDesign prompt construction used by the resident bridge, keeps
VoiceDesign request details off stdout, and changes MLX build guidance to match
this bundled source tree. The upstream high-level VoiceDesign API at the pinned
revision returns placeholder silence; the rest of the low-level inference
engine remains the native backend used by Open TTS.

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
   confirm `build_voice_design_input_embeddings`, the VoiceDesign branch in
   `generate_with_instruct`, and the bundled mlx-c error message still match
   the new upstream APIs.
6. Update both pinned revisions, refresh `OPEN_TTS.patch`, and update the
   expected vendor digest in `electron/qwen3Vendor.test.ts` in the same change.
7. Run `npx vitest run electron/qwen3Vendor.test.ts`, then the Rust bridge tests
   on Apple Silicon and Windows x64. An Apple Silicon release build must also
   contain the expected `mlx.metallib` next to the bridge binary.

The guard deliberately hashes the exported source plus the applied Open TTS
patch while excluding this note, the patch file itself, and Cargo's
`.cargo-ok` marker. Any vendor drift therefore requires an explicit pin,
patch, and digest review.
