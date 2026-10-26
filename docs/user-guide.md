# User guide

Everything Open TTS can do, in detail: features, models, settings, keyboard
shortcuts, document import, and runtime behavior. The [README](../README.md) is
the short version.

## Features

| Capability | Details |
|---|---|
| **Local & private** | Every synthesis path runs on-device. Network access is used only to download model/runtime assets on first use. |
| **Browser models** | Web browsers expose Kokoro-82M, Supertonic 2, Kitten TTS 0.8, Paradee-8M, and Piper; Electron replaces Supertonic 2 with Supertonic 3 and adds Chatterbox Turbo. Each engine keeps its own saved settings. |
| **Studio & Reader** | A focused synthesis workspace plus a long-book Reader with a searchable table of contents, full-text search, paragraph-block rendering, bounded section rendering/generation, stable whole-book progress, arrow-key section paging, exact-word double-click seeking, sentence and paragraph stepping, a selection toolbar (listen, bookmark, highlight, or note), coloured highlights, bookmarks with text previews, quoted notes with Markdown/JSON export, EPUB covers, a sleep timer, a focus layout that hides the app header, and automatic continuation (on by default). |
| **Gapless Reader** | The Reader prepares the next section in the background while the current one plays, so turning to it starts without a pause (**Reading appearance → Prepare the next part**). OS media keys and Now Playing show the book, chapter, and cover; each book remembers its engine, voice, language, quality, and speed. |
| **Audiobook export** | Export a chapter or a whole book as one MP3 with chapter markers (ID3 `CHAP`/`CTOC`) or a zip of numbered chapter MP3s with a playlist and cover. Rendered parts are reused, progress and cancel are shown, and a retry keeps finished chapters. |
| **Voice Library** (desktop) | One searchable catalog of every engine's voices and your own: previews, favorites, saved presets, tags, one-click use in Studio or the Reader, and portable `.voice.zip` import/export. |
| **Instant voice cloning** (desktop) | A wizard records from the microphone or takes a WAV, trims it on a waveform, gives per-engine quality guidance, collects the transcript, and saves the clone for Qwen3 Base, NeuTTS, or Chatterbox Turbo (which needs no transcript). |
| **Voice Design** (desktop) | Describe a voice, audition three seeded previews, and save the one you like, optionally as a Qwen3 Base clone reference. |
| **Generation History** | Studio saves finished generations with text, engine, voice, seed, and audio (bounded to 200 entries / 512 MiB, with a separate favorites budget) so you can replay, export, reuse, favorite, or delete them. |
| **Variations** | Render three seeded (or speed-varied) takes of the script or a passage, audition each, and put the best one in the timeline. |
| **Dialogue** | Write `Name: line` scripts, cast an engine and voice per speaker, render turn by turn with cancel and per-line regenerate, and export audio with VTT or SRT captions. |
| **Studio-grade export** | WAV (32-bit float, 24-bit, 16-bit PCM), FLAC (16- and 24-bit), and MP3, with loudness targets for streaming, podcasts, broadcast, and ACX audiobooks, a true-peak limiter, silence trimming, padding, fades, resampling, and a loudness report (LUFS, loudness range, true peak, ACX check) after every export. Exports show progress and can be cancelled. |
| **Estimated captions** | Export estimated SRT, VTT, or JSON timings alongside the audio, split into readable cues (two 42-character lines, 7 s at most). |
| **Creator presets** | One-click TikTok Voiceover, YouTube Shorts, and YouTube Long-form profiles. |
| **Delivery tuning** | Adjustable speed and pause shaping (controls an engine ignores are disabled with the reason), seeds for repeatable takes, and `<break time="1.5s"/>` / `[pause 500ms]` tags that insert exact silences up to 10 seconds on every engine. They are never read aloud. |
| **Pronunciation dictionaries** | Named, toggleable lists of alias or IPA rules (case, whole-word, and language options), tested against a phrase and imported/exported as JSON or W3C PLS. Uppercase rules are case-sensitive and whole-word by default, the longest match wins, and rules never cascade. PLS carries only alias and IPA phoneme rules; the case and scope options are not representable. IPA speaks its alias until an engine reads phonemes. |
| **Text normalization & cleanup** | Optional English normalization reads numbers, dates, times, currency, units, abbreviations, URLs, emails, and Roman numerals as words. Cleanup removes citations, footnote markers, links, emoji, Markdown syntax, and PDF artifacts, with a preview of every change and undo. A script preflight shows the spoken text, pause map, and length estimate. Emphasis markers (`*word*`, `**word**`, `[[word]]`) are stripped and never repeated; emphasis is not rendered. |
| **Appearance & reading fonts** | System/light/dark themes, four accents, interface scaling, three interface fonts, four Reader fonts, and persistent Reader page tone (paper, sepia, night), text size, line spacing, column width, and focus controls. |
| **Desktop keyboard workflow** | Cross-platform navigation, generation, stop, playback, and seeking shortcuts, documented inside Settings. |
| **Accessible motion and material** | Independent reduced-motion and reduced-transparency preferences with responsive controls and keyboard focus handling. |
| **Offline reuse** | Model weights cache in-browser (IndexedDB + Cache API) for repeat use, subject to browser quota, persistence, and eviction behavior. |
| **Desktop runtimes** | Electron adds Supertonic 3, Audio8, Chatterbox Turbo, and Qwen3-TTS to Studio/Reader and exposes NeuTTS Nano/Air and Qwen3 setup pages through a resident Rust WebSocket bridge. A selected Qwen3 model stays loaded (up to 30 idle minutes), and a rotating diagnostics log (`userData/logs/main.log`) records native failures for bug reports. |
| **Shared Qwen voices** | Electron exposes one Qwen profile, speaker, language, instruction, and sampling state across Studio, Reader, and the dedicated setup page. The active speaker is visible and selectable inline. |
| **Guided Qwen setup** | A prominent download/repair action, total progress, current-file details, actionable errors, validation, and an optional existing-folder path. |
| **Document import** | Bring EPUB, PDF, text, Office, image, HTML, and web-article content into Reader; the desktop shell also exposes file import to Studio. Extraction is local after any source file or page has downloaded. See [Document import](#document-import). |

## Models

| Model / runtime | Source | Routes | Web | Desktop | Notes |
|---|---|---|:---:|:---:|---|
| **Kokoro-82M** | `onnx-community/Kokoro-82M-v1.0-ONNX` via `kokoro-js` | `/studio`, `/reader` (`/desktop/*` on desktop) | Yes | Yes | 24 kHz browser model, 28 named voices; model and voice assets are revision-pinned |
| **Supertonic TTS 2** | `onnx-community/Supertonic-TTS-2-ONNX` via `@huggingface/transformers` | `/studio`, `/reader` | Yes | No | Legacy 44.1 kHz web/iOS model; replaced by Supertonic 3 in Electron |
| **Kitten TTS Nano 0.8** | KittenML, Apache-2.0, pinned ONNX | `/studio`, `/reader` (`/desktop/*` on desktop) | Yes | Yes | 15M parameters, 60 MB, eight English voices (Bella, Jasper, Luna, Bruno, Rosie, Hugo, Kiki, Leo), 24 kHz, WebGPU or WASM, exact per-word timings |
| **Paradee-8M** | Sahil Mahendrakar, Apache-2.0, pinned ONNX | `/studio`, `/reader` (`/desktop/*` on desktop) | Yes | Yes | 9 MB English voice ("Heart") distilled from Kokoro's `af_heart`; runs on the CPU by design and starts almost instantly |
| **Piper** | `rhasspy/piper-voices` (MIT), pinned per voice | `/studio`, `/reader` (`/desktop/*` on desktop) | Yes | Yes | Eight curated English voices (see below), downloaded per voice on first use; CPU/WASM |
| **Chatterbox Turbo** | `ResembleAI/chatterbox-turbo-ONNX` (MIT), pinned | `/desktop/studio`, `/desktop/reader` | No | Yes | **WebGPU only** (its quantized graphs need `GatherBlockQuantized`, which the WASM provider lacks). Zero-shot cloning from a 3-10 s WAV clip, no transcript; inline tags such as `[laugh]`, `[sigh]`, `[whispering]`; temperature, top-k, top-p, repetition-penalty and seed controls; about 0.9 GB first download. Slower than real time on an Apple GPU |
| **Supertonic 3** | Revision-pinned `Supertone/supertonic-3` ONNX assets | `/desktop/studio`, `/desktop/reader` | No | Yes | Electron-only renderer worker; 99M parameters, 10 voices, 31 languages, expression tags, seed control, WebGPU/WASM |
| **Audio8 TTS Preview 0.6B ONNX INT4** | [`Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4`](https://huggingface.co/Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4) | `/desktop/studio`, `/desktop/reader` | No | Yes | Native local 44.1 kHz CPU inference in an Electron worker thread; 572 MiB one-time model download, six voices whose small profiles are cached on first use; optional seed and temperature; model and voice profiles are both revision-pinned |
| **NeuTTS Nano / Air** | Neuphonic GGUF variants via Rust `neutts` | `/desktop/neutts` | No | Yes | Nano Q4 for English, German, French, and Spanish, plus higher-quality Air 0.7B Q4/Q8 for English; accepts a reference WAV or pre-encoded `.npy` codes plus its matching transcript |
| **Qwen3-TTS Native** | Pinned `qwen3-tts-rs` inside the Rust bridge: MLX on Apple Silicon and LibTorch on Windows x64 | `/desktop/studio`, `/desktop/reader`, `/desktop/qwen3` | No | Yes | One resident inference process; CustomVoice, Base voice cloning, and VoiceDesign 1.7B share revision-pinned downloads and one renderer settings state. Windows remains available for custom builds but is not distributed in GitHub Releases |

**Piper voices.** The catalog holds only voices whose whole training lineage is permissively licensed (it fails closed on anything unstated):

| Voice | Accent | Dataset licence |
|---|---|---|
| Kristin, John, Norman, LJSpeech (medium and high) | US English | Public domain (LibriVox / LJ Speech) |
| Cori (medium and high) | UK English | Public domain (LibriVox) |
| LibriTTS (high; 904 speakers, chosen by number) | US English | CC BY 4.0 |

Voices derived from non-permissive corpora (Lessac, Ryan, VCTK, and others) are excluded. Settings → Credits lists each model's licence and the attribution LibriTTS requires.

> The web build (`npm run dev:web`) is not deployed anywhere and exposes browser Studio and Reader only. Desktop routes (`/desktop/*`, including the Voices page) are opened by Electron. Chatterbox Turbo needs WebGPU; on a device without it the picker keeps your saved choice but runs the default engine.

## Settings

Open Settings from the slider button in the top-right corner, or press <kbd>⌘</kbd> <kbd>,</kbd> on macOS and <kbd>Ctrl</kbd> <kbd>,</kbd> on Windows/Linux.

| Area | Options |
|---|---|
| **Theme** | Follow the operating system, force light mode, or force dark mode. |
| **Accent** | Blue, violet, teal, or orange. |
| **Interface** | Small, default, or large UI scaling; Inter, system, or Outfit app font. |
| **Reading** | Literata, Inter, Outfit, or Georgia for long-form Reader documents. |
| **Accessibility** | Reduce transparency and reduce motion independently. |
| **Optional models** | Show or hide NeuTTS Nano/Air and Qwen3-TTS setup pages in desktop navigation. Hiding Qwen does not remove it from Studio or Reader. |

Preferences persist locally and apply across Studio, Reader, and desktop runtime pages.

## Keyboard shortcuts

Shortcuts work while Open TTS is the active application. Space keeps its normal behaviour whenever focus is inside a text field or on another control, such as a button. OS media keys also control the Reader (play/pause, seek, previous/next section).

| Action | macOS | Windows / Linux |
|---|---|---|
| Open Settings | <kbd>⌘</kbd> <kbd>,</kbd> | <kbd>Ctrl</kbd> <kbd>,</kbd> |
| Go to Studio | <kbd>⌘</kbd> <kbd>1</kbd> | <kbd>Ctrl</kbd> <kbd>1</kbd> |
| Go to Reader | <kbd>⌘</kbd> <kbd>2</kbd> | <kbd>Ctrl</kbd> <kbd>2</kbd> |
| Generate speech | <kbd>⌘</kbd> <kbd>Return</kbd> | <kbd>Ctrl</kbd> <kbd>Enter</kbd> |
| Stop generation | <kbd>⌘</kbd> <kbd>.</kbd> | <kbd>Ctrl</kbd> <kbd>.</kbd> |
| Play or pause | <kbd>Space</kbd> | <kbd>Space</kbd> |
| Skip backward / forward 10 seconds | <kbd>⌥</kbd> <kbd>←</kbd> / <kbd>→</kbd> | <kbd>Alt</kbd> <kbd>←</kbd> / <kbd>→</kbd> |
| Previous / next Reader section | <kbd>←</kbd> / <kbd>→</kbd> | <kbd>←</kbd> / <kbd>→</kbd> |
| Previous / next sentence (Reader) | <kbd>⇧</kbd> <kbd>←</kbd> / <kbd>→</kbd> | <kbd>Shift</kbd> <kbd>←</kbd> / <kbd>→</kbd> |
| Previous / next paragraph (Reader) | <kbd>⇧</kbd> <kbd>↑</kbd> / <kbd>↓</kbd> | <kbd>Shift</kbd> <kbd>↑</kbd> / <kbd>↓</kbd> |
| Move between paragraphs (Reader, once one is focused) | <kbd>↑</kbd> / <kbd>↓</kbd> | <kbd>↑</kbd> / <kbd>↓</kbd> |
| Listen from the focused paragraph / select it | <kbd>Return</kbd> / <kbd>⇧</kbd> <kbd>Return</kbd> | <kbd>Enter</kbd> / <kbd>Shift</kbd> <kbd>Enter</kbd> |
| Listen from a word (Reader) | Double-click | Double-click |
| Toggle the Reader focus layout | <kbd>F</kbd> | <kbd>F</kbd> |
| List Reader shortcuts | <kbd>?</kbd> | <kbd>?</kbd> |

## Document import

The desktop app adds an **Import** button to Studio and Reader. Electron's main process owns the native file dialog and bounded import IPC, while [LiteParse](https://www.llamaindex.ai/liteparse) handles PDF, Office/OpenDocument, and image extraction in a one-shot worker thread. The worker is terminated after completion or at the five-minute deadline, so parser CPU work and native state do not live in the Electron main process. Plain text is read directly, while EPUB and HTML structure is parsed in the renderer. Reader can also extract an article from a URL.

| Format | Extensions / source | Availability | Processing path |
|---|---|---|---|
| EPUB | `.epub` | Web Reader and desktop Reader | Unpacked and structured in the renderer; the desktop main process transfers the selected bytes without parsing them |
| Plain text | `.txt` `.md` | Web Reader and desktop | Read directly; Markdown headings become chapters and inline syntax is stripped so it is never shown or spoken |
| HTML | `.html` `.htm` | Web Reader local-file picker | Parsed in the renderer with article/heading extraction |
| PDF | `.pdf` | Desktop | LiteParse, with OCR for scanned pages; running headers, footers, and page numbers (edge lines repeated on at least 40% of pages, in documents of three or more pages) are dropped; some PDFs require a local Ghostscript install |
| Office / OpenDocument | `.docx` `.pptx` `.odt` | Desktop, with LibreOffice | Converted through a local LibreOffice install before LiteParse extraction |
| Images | `.png` `.jpg` `.jpeg` `.tif` `.tiff` `.webp` | Desktop, with ImageMagick | Converted locally with ImageMagick, then OCR'd |
| Article URL | `http://` or `https://` | Reader | Desktop uses a 10 MB, 30-second SSRF-safe fetch that rejects credentials and local-network targets, pins DNS, and rechecks redirects; the web build fetches directly and is therefore subject to the site's CORS policy |

Guard rails keep imports predictable: imported files have a 100 MB cap, extracted text has a 1.5 million character cap, and LiteParse work has an 800-page cap and five-minute deadline. EPUB extraction separately limits archive expansion and entry count. The first OCR use downloads Tesseract language data once; subsequent OCR can run offline while that data remains cached. LibreOffice, ImageMagick, and Ghostscript are optional local prerequisites for the formats noted above.

Reader keeps the full imported book in its local library but works on one bounded, sentence-aligned section at a time, which keeps rendering, synthesis, and seeking responsive across long books. Chapters remain the visible table of contents, and progress, bookmarks, and notes survive section changes. See [local persistence](./storage.md) for how this is stored on web and desktop.

## Runtime notes

- Browser model assets download on first use and cache locally for repeat use. Network-free operation depends on the required app/model assets still being present in browser storage.
- Audio8 downloads only the three inference graphs, their external weights, the tokenizer, and the runtime manifest — eight files, 572 MiB — plus a small voice profile the first time each voice is used. The repository's ~395 MiB voice-registration encoder is not downloaded: Open TTS ships pre-registered voices and never registers new ones on the device. Every file is checked against a pinned byte length and digest before it is loaded, and the cache can be inspected and cleared from Audio8's model settings.
- WebGPU is preferred where available; the WASM fallback is expected behavior.
- iPhone and iPad browsers: Kokoro is intentionally disabled on iOS pending further validation; Supertonic is the validated engine there.
- Qwen3 model weights are downloaded explicitly from its setup page and cached by immutable profile revision. The app reports overall/file progress, verifies the result, and offers repair/re-download. CustomVoice needs no reference clip; Base voice cloning requires a WAV and its exact transcript; VoiceDesign uses a natural-language voice description. NeuTTS accepts a WAV reference or pre-encoded `.npy` codes plus the matching transcript.
- App preferences and Reader library data stay local: the web build uses browser storage and Electron keeps the Reader library in a per-user SQLite file. No account or hosted database is required.
