# Changelog

All notable changes to Open TTS are documented here.

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
