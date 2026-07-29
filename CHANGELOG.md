# Changelog

All notable changes to Open TTS are documented here.

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

[1.7.3]: https://github.com/cyanxxy/Local-TTS-studio/releases/tag/v1.7.3
