# Changelog

All notable changes to Open TTS are documented here.

## [Unreleased]

## [1.8.0] - 2026-08-05

### Added

- Added Audio8 TTS Preview 0.6B ONNX INT4 as a desktop model in Studio and
  Reader. It runs the pinned INT4 graphs on the CPU through `onnxruntime-node`
  in an Electron worker thread — not through the Rust bridge and not in the
  renderer — and returns 44.1 kHz mono audio. Six pre-registered voices are
  offered: Clara, Iris, Arthur, Mia, Ben, and Sophie.
- First use downloads 572 MiB of Audio8 assets into
  `local-model-cache/audio8/<revision>/` inside the per-user app data
  directory: three inference graphs with their external weights, the tokenizer,
  and the runtime manifest. Each file is checked against an exact byte length
  and an upstream digest before it is loaded, and a voice profile is fetched
  the first time that voice is used. The 395 MiB voice-registration encoder is
  deliberately not downloaded, because Open TTS ships pre-registered voices and
  never registers new ones on the device.
- Audio8's model settings now report the cache path and size and can clear it,
  the way the NeuTTS and Qwen3 setup pages already did for their models. Both
  figures cover every Audio8 revision on disk rather than the current one, so a
  later revision bump cannot leave behind half a gigabyte the app never counts
  and no in-app action can reclaim; superseded revisions are also pruned after
  a load succeeds. Clearing stops the inference worker before unlinking,
  because the graphs stay memory-mapped while it runs and Windows fails such an
  unlink outright instead of deferring it the way POSIX does.

### Changed

- `onnxruntime-node` is now a direct dependency pinned to one exact version,
  with an `overrides` entry that holds every other consumer to it.
  Transformers.js and `kokoro-js` each depend on it as well, and
  Transformers.js imports it from a static top-level import, so the previous
  three resolved copies (677 MB in `node_modules`) could load a second native
  ONNX Runtime into the same worker thread. One shared copy is 259 MB, and
  `vite.onnxRuntimeVersion.test.ts` now fails if the lockfile ever resolves
  more than one version again.
- Desktop packaging now ships only the target platform's ONNX Runtime binaries
  instead of all 258 MB of them: 74 MB on macOS arm64 and 61 MB on Windows x64.

## [1.7.5] - 2026-07-30

### Changed

- Reworked the Reader's chapter navigation into a single running head docked to
  the top of the reading pane. The chapter title, contents shortcut, page turns,
  and progress now live in one row instead of being restated in the toolbar
  subtitle, a floating strip, and the page header. Both page turns sit together
  as one segmented control on the left rather than straddling the title.
- Chapter ordinals ("Chapter 12 of 135") moved off screen into the accessible
  label, where they orient screen-reader users without adding noise to an EPUB
  with a large spine.
- Page-turn buttons now name their destination — "Next chapter: …" when the turn
  crosses a chapter boundary, "Next part of this chapter" when it does not — and
  in-chapter position reads as dots rather than "Part 2 of 3".
- The contents shortcut opens the library straight on the Contents tab, and
  continuation sections open with a quiet "… · continued" marker instead of
  repeating the chapter title at full size.
- The Studio ⇄ Reader switch now moves one measured pill between the tabs and
  cross-fades the page beneath it, instead of the active pill blinking from one
  tab to the other and the page cutting over. The tabs also expose
  `aria-current="page"`.
- Reading highlights inverted their emphasis: the spoken sentence is a colourless
  paper wash and the accent now belongs to the word being spoken, so a long
  sentence no longer paints half the page blue.

- Qwen3 CustomVoice and VoiceDesign now stream audio while a sentence is still
  being generated, instead of waiting for the whole sentence to finish. Audio
  starts after a few code frames rather than a full text unit, which is the
  dominant term in how fast playback feels. Voice cloning already worked this
  way; all three modes now share the same generate/decode path, and the 0.2 s
  gap between sentences is preserved by holding each chunk back by one so it
  can ride on the unit's final chunk.
- Stopping a local Qwen3 generation no longer throws away the loaded model. The
  bridge gained a `cancel` command and checks for it on each streamed chunk, so
  a Stop unwinds the request in place and the process stays warm for the next
  generation instead of being killed and reloaded from scratch. A bridge that
  does not acknowledge within 20 seconds is still killed.
- Desktop LiteParse extraction moved out of Electron's main process into a
  bounded one-shot worker. The main process still owns the file dialog and IPC,
  while completion, failure, cancellation, and the five-minute deadline all
  terminate the parser worker.
- Browser Kokoro and Supertonic workers now leave memory after 15 seconds of
  inactivity, Supertonic 3 loads its ONNX files sequentially instead of holding
  every model download at once, and inactive desktop runtime pages unmount
  instead of retaining every model visited during the session.
- Qwen's larger MLX worker now leaves memory after one idle minute. Cancelling a
  browser or Supertonic 3 generation hard-restarts its worker so an opaque
  WebGPU/WASM inference call cannot continue consuming resources after Stop.
- Streamed playback now extends its semantic timeline incrementally rather than
  rebuilding it for every chunk. Reader cache snapshots avoid redundant PCM
  copies, oversized chapters are not pinned in renderer memory, persistence
  transfers its copy through the preload bridge, and local runtime playback no
  longer rescans all preceding chunks for every arriving frame.

### Fixed

- Fixed Reader article imports failing in Electron with
  `ERR_INVALID_IP_ADDRESS: undefined`. The DNS-pinned request lookup now returns
  Node's required address-array shape when automatic family selection asks for
  every resolved address.
- Fixed Qwen Reader playback moving the active-word marker backward while a
  sentence was still streaming. Sentence highlighting remains live during
  generation, while estimated word timing begins only once that sentence's
  duration is stable.
- Fixed Reader auto-follow tracking only the active sentence. The scroll effect
  now follows word-index changes from the playback clock, so the spoken-word
  accent cannot walk off-screen inside a long wrapping sentence.
- Fixed Stop clearing completed Qwen audio. Cancelling an active generation now
  retains chunks already delivered to the player, while Stop on an idle,
  finished job only stops playback sources.
- Fixed the spoken-word marker being unreadable during playback. The word span
  carries its sentence's classes, and the sentence's breathing animation
  outranks any normal declaration, so the animated wash painted over the
  marker's own fill.
- Fixed stalled or failed WebSocket writes being reported as a clean client
  disconnect. The bridge treated every I/O error that way, so a write that hit
  its 30-second timeout exited with no result frame and the real cause was
  replaced by a generic "closed before returning a result".
- Fixed bridge errors that carry no request id — an unparseable request
  envelope, say — being discarded behind an id-mismatch message instead of
  surfacing what actually went wrong.
- Fixed a connect race that could kill the bridge during startup. Each attempt
  had a one-second slice of the connect budget, and an attempt that expired
  mid-handshake closed a connection the bridge had already accepted; since the
  bridge exits after its one owning connection, every later retry then hit a
  dead port. Attempts now use the whole remaining budget.
- Fixed a streamed audio batch that decodes to no samples aborting a voice-clone
  request with "Qwen3 generated empty audio". A batch shorter than the vocoder's
  lookahead legitimately produces nothing; it is buffered state, not a failure.
- Fixed the per-batch streaming decode writing two diagnostic lines to stdout
  for every chunk. With sentence-level streaming that ran hundreds of times per
  request against the bridge's bounded stdout buffer, whose overflow fails the
  request and kills the resident worker.
- A Qwen3 text unit that generates no audio at all is now reported with the
  section number instead of being silently dropped from the output.

### Security

- The bridge now refuses a WebSocket upgrade carrying an `Origin` header.
  WebSocket connections are exempt from CORS, so any page could attempt a
  loopback connection; the path token already made that useless, but Electron
  never sends `Origin`, so rejecting browser-originated upgrades removes the
  attack class outright.
- WebSocket handshakes moved off the accept loop, capped at 8 concurrent. A peer
  that connected and then went silent previously held the listener for its whole
  handshake deadline, and two such connections could outlast a legitimate
  client's connect budget. The first authenticated upgrade now atomically owns
  the process, closes the listener, and causes any simultaneously completed
  orphan upgrades to be dropped immediately.

### Release

- Bumped the application and lockfile version to `1.7.5`.
- A verified release PR merged to `main` now creates its matching version tag
  and publishes a source-only GitHub Release from the checked-in notes. Unsigned
  desktop installers remain local build outputs and are not published.

## [1.7.4] - 2026-07-29

### Fixed

- Fixed auto-follow silently staying engaged after a manual scroll. A jump that
  landed on an unchanged scroll position left the programmatic-scroll flag armed,
  so the next real user scroll was swallowed and the resume pill never appeared.
- Fixed a parked cross-section scroll offset hijacking a later, unrelated section
  change when the Reader was rendered without a navigation handler.
- Fixed the note pill flashing for a frame on every double-click-to-listen.
- Fixed the reading pane rendering an empty panel with no guidance when a section
  has no text; it now offers an inline way into editing.
- Fixed reading-appearance and voice popovers keeping stale geometry when their
  contents changed height after opening.
- Fixed arrow-key page turns firing from toolbar buttons and repeating while an
  arrow key is held, each repeat forcing a full flush, save, and restore cycle.
- Fixed the spoken-word highlight losing contrast in focus mode, and the spoken
  sentence continuing to pulse while playback is paused.
- Fixed the Reader library drawer behaving as a non-modal dialog: it now traps
  Tab, marks itself modal, and closes on click-away behind a scrim layered above
  the player dock.
- Fixed the Contents, Search, Bookmarks, and Notes tabs rendering a blank panel
  when no document is open.
- Fixed a stale delete confirmation persisting across drawer closes and tab
  changes, and bookmarks in one chapter all sharing an identical label.

### Changed

- Reader library drawer tabs are now a real tablist with `aria-selected`, roving
  focus, and arrow, Home, and End navigation.
- Document search now debounces input and folds the document text once per
  document instead of on every keystroke and every playback progress sample, and
  document title and author edits are debounced instead of writing per keystroke.
- Reader library rows re-render individually rather than as a whole list on each
  playback progress sample, and relative "opened" times refresh while the drawer
  is open.
- Removed the chunk-boundary span splitting from the reading pane. The attribute
  it produced was read by nothing at runtime and cost dozens to hundreds of
  identical spans per section.

## [1.7.3] - 2026-07-26

### Added

- Added a desktop Reader library backed by Electron's bundled `node:sqlite`
  engine. A dedicated worker owns the database, with WAL journaling,
  transactional schema initialization, stale-write protection, indexed LRU
  pruning, and bounded chunk streaming for generated PCM.
- Added a first-launch migration that copies documents and the active selection
  from the earlier desktop IndexedDB library without deleting the legacy copy.
- Added full-text Reader search with source-offset-safe Unicode matching, plus
  focused tests for the five-tab library drawer, keyboard focus, and search
  behavior.
- Added main-process, preload, worker, database, IPC, cache-size, desktop
  library, model-option, and sidebar coverage, along with a dedicated Electron
  test TypeScript configuration and a top-level `typecheck` command.
- Added local-persistence documentation covering storage backends, the SQLite
  schema, shutdown behavior, cache limits, and backups.

### Changed

- Reader writes now use monotonic timestamps, track in-flight persistence, and
  flush debounced edits on page teardown or a bounded Electron quit request.
  Expected shutdown rejections are ignored while real worker failures remain
  visible.
- Qwen3 CustomVoice now sends explicit Aiden/English defaults through renderer,
  IPC, and Rust, labels speakers with their native languages, and orders the
  English-native choices first.
- Increased the Qwen3 generation budget from 1,536 to 8,192 tokens across the
  UI, bridge, CLI, worker, and vendored runtime. Budget exhaustion without an
  end-of-speech token is now reported as an error instead of returning
  truncated audio as a successful generation.
- Moved cache-directory sizing into a bounded-concurrency module so large model
  caches do not overwhelm Electron's main process.
- Expanded and reorganized the README and architecture/runtime documentation to
  describe browser and desktop capabilities, storage, model behavior, build
  scripts, and release limitations more clearly.

### Release

- Bumped the application and lockfile version to `1.7.3`.
- Added checked-in release notes support to the desktop release workflow so a
  tagged build can publish the full curated notes instead of only generated
  commit summaries.

[1.8.0]: https://github.com/cyanxxy/Local-TTS-studio/releases/tag/v1.8.0
[1.7.5]: https://github.com/cyanxxy/Local-TTS-studio/releases/tag/v1.7.5
[1.7.4]: https://github.com/cyanxxy/Local-TTS-studio/releases/tag/v1.7.4
[1.7.3]: https://github.com/cyanxxy/Local-TTS-studio/releases/tag/v1.7.3
