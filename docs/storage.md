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

## Audio8 model cache

The desktop Audio8 runtime downloads its weights into
`local-model-cache/audio8/<model revision>/`, under the same
`app.getPath("userData")` directory as the Reader database and beside the
per-model directories the Rust bridge runtimes use. The revision is currently
`818569c6b832118ad68d61bbd873abe250fcd68a`. A cold load writes eight files
totalling 599,933,441 bytes (572.1 MiB): three ONNX graphs, their external
`.data` weights, the tokenizer, and the runtime manifest. Voice profiles are
fetched per voice, the first time that voice is used, into `voices/<id>/`;
all six together are under 13 KiB, so the model files determine the size of the
cache no matter how many voices a user has tried.

Every file is verified before it is used, against both its exact byte length and
a digest. The digest algorithm depends on how the Hub serves the file: SHA-256
for the large files behind LFS, and the git blob SHA-1 of `blob <size>\0` plus
the content for the small text files served as plain blobs, which is the only
digest those expose. Size alone accepts a stale copy of the same length or a
file that was truncated and re-appended, and the result of loading one is
either garbled audio or an opaque runtime error.
Downloads are written to a `.partial` path and renamed only once the length and
digest both match; a `.partial` left behind by an interrupted run is deleted
rather than resumed, because the transfer has no resume support.

Size reporting and clearing operate on the whole `audio8` namespace rather than
on the current revision's directory. The download path is revision-scoped, so
scoping them to the current revision would leave a superseded revision's
572 MiB missing from the storage readout and unreclaimable from inside the app.
For the same reason, a successful load prunes revision directories other than
the current one. Pruning is tied to a completed load rather than to startup:
that is the only moment the current revision is known to be fully downloaded
and open, so reclaiming disk cannot be what leaves a user without a usable
model, and every directory it touches provably belongs to a revision the worker
has not mapped.

Clearing stops the inference worker before unlinking anything. The worker keeps
the ONNX graphs memory-mapped out of the revision directory, and Windows fails
an unlink of a mapped file outright instead of deferring it until the last
handle closes the way POSIX does. Load and synthesis requests that arrive while
a clear is running wait behind it, so a request cannot start a replacement
worker that downloads into the directory the `rm` is about to remove. Quitting
waits for an in-flight clear or prune for the same reason it waits for the
workers and bridge children: an exit part way through the `rm` leaves a torn
directory behind.

Both operations are exposed on the `audio8:cache-info` and `audio8:clear-cache`
IPC channels, and the path, size, and clear action are rendered in Audio8's
model settings in Studio and Reader. Audio8 is not a `LocalModel`, so it cannot
use the `local-tts:cache-info` and `local-tts:clear-cache` channels the bridge
runtimes share — those are keyed by the bridge-routing model union — but they
return the same `LocalCacheInfo` shape, so the renderer presents both caches
the same way.
