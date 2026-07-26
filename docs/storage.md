# Local persistence

Open TTS does not require an account, hosted database, telemetry service, or
proprietary storage SDK. Persistence stays on the user's device.

## Storage backends

| App target | Reader library | Preferences and routing | Model files |
|---|---|---|---|
| Web | IndexedDB | `localStorage` | Browser Cache API / IndexedDB |
| Electron desktop | SQLite | `localStorage` | Per-user app cache |

The Reader backends are independent apart from one upgrade path: the first time
a desktop build reads the library, it imports the documents a pre-SQLite release
left in the renderer's IndexedDB, so upgrading does not look like an erased
library. That import copies documents and the active-document selection, never
cached audio — audio is regenerated on demand instead of being streamed across
the bridge while the app is still starting. The IndexedDB copy is left in place
so an older desktop build still finds its data, and an import that fails is
retried on the next launch. Electron never rewrites or deletes Reader records in
IndexedDB.

Electron uses the public-domain SQLite engine included with its Node.js runtime
through `node:sqlite`; there is no native package to install or rebuild. The
database is named `reader-library.sqlite3` and lives under Electron's
platform-specific `app.getPath("userData")` directory. A dedicated worker owns
the connection so database waits and large writes cannot block Electron's main
thread. Generated PCM crosses process boundaries one bounded chunk at a time
with backpressure instead of as one large IPC payload.

## SQLite schema

`PRAGMA user_version` records the initialized schema version. Schema version 1
contains:

- `documents`: normalized Reader document records, including progress,
  bookmarks, notes, and chapter metadata.
- `settings`: Reader-scoped key/value state such as the active document.
- `reader_audio`: generated section-audio metadata and LRU fields.
- `reader_audio_chunks`: ordered PCM blobs with a cascading foreign key to
  `reader_audio`.

Indexes cover document recency, audio lookup by document, and audio LRU
pruning. The initial schema is created transactionally.

The connection enables foreign keys, WAL journaling, a five-second busy
timeout, and normal synchronous durability. Document and audio writes reject
older snapshots so a delayed renderer write cannot replace a newer one. Writes
that carry an equal timestamp are the same logical snapshot, so the last one
wins — matching the IndexedDB backend the web Reader uses.

Deleting a document or its audio also cancels any streamed save still arriving
for it. A save is only committed once its final chunk lands, and `reader_audio`
is keyed independently of `documents`, so a save allowed to finish after the
delete would reinsert an entry belonging to no document.

## Shutdown

Renderers hold Reader edits behind a debounce timer for up to a second. Quitting
asks every open window to write those out and waits for them before the worker
stops accepting work, because closing the worker first left the last edit
rejected and silently discarded. A window that never answers cannot delay the
quit past its bounded flush window. Closing a window or a browser tab flushes
the same way, on both targets.

## Cache limits and backup

SQLite uses the same generated-audio limits as the web Reader: 96 sections or
512 MiB total, with a 256 MiB maximum for one entry. The current write is
protected while older entries are pruned.

For a consistent manual backup, quit Open TTS and copy
`reader-library.sqlite3`. While the app is open, SQLite may also have `-wal` and
`-shm` sidecar files.
