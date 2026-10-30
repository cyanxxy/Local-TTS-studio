# Local persistence

Open TTS does not require an account, hosted database, telemetry service, or
proprietary storage SDK. Persistence stays on the user's device.

## Storage backends

| App target | Reader library | Preferences and routing | Model files |
|---|---|---|---|
| Web | IndexedDB | `localStorage` | Browser Cache API / IndexedDB |
| Electron desktop | SQLite | `localStorage` | Per-user app cache |

The Voice Library and Generation History are renderer IndexedDB databases on both targets and are independent of the Reader library (see below).

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
platform-specific `app.getPath("userData")` directory. On Windows a new install
moves that directory from the roaming `%APPDATA%\Open TTS` to
`%LOCALAPPDATA%\Open TTS`, so domain profiles do not sync gigabytes of model
cache at every sign-in; an install that already has the roaming folder keeps
using it (`electron/userDataLocation.ts`). A dedicated worker owns
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

Reading progress has its own table, `document_progress` (`document_id`,
`progress_json`, `updated_at`), created with `CREATE TABLE IF NOT EXISTS` on
every open rather than behind `user_version`, so the schema version is
unchanged and an older build that opens the database simply ignores the table.
The renderer writes progress through `reader-library:save-progress` at most
every 5 seconds while playing and flushes on pause, window hide, and quit,
instead of rewriting the whole document row. Reads merge the two: the newer of
the row and the progress inside the document record wins. The main process
keeps only the known progress fields (ids are bounded to 512 characters) and
clamps a timestamp to 2 seconds ahead of the clock so a future-dated row
cannot block later writes. On the web the same record is a `progress:<id>` key
in the settings store.

Document records may also carry optional `highlights[]`
(`{id, start, end, color, quote, createdAt, updatedAt}`) and `cover`
(`{dataUrl}`, a raster data URL of at most 384 KiB). Both are additive, need no
schema or `DB_VERSION` change, and older builds ignore them. Stored highlights
are validated on load (safe-integer offsets, duplicate ids keep the first, a
quote re-anchors over its own length).

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

## Generated-audio cache writes

Section audio is stored with a metadata record that keeps the `signature` the
audio was generated under and a `synthesisComplete` flag, so the Reader can ask
`reader-library:get-audio-signature` whether a section is complete without
reading its PCM (the web build falls back to the audio record for entries saved
before the metadata held a signature). The Reader no longer rewrites unchanged
audio on restore or at the gaps between streamed chunks, streaming saves land
about every 30 seconds, and the browser cache compares metadata instead of
reading audio to check timestamps. Reader signatures are version 2: audio saved
under a version 1 signature is recognized and re-saved when its inputs match,
and otherwise regenerates once.

## Voice Library

`open-tts-voice-library` is an IndexedDB database (managed by
`openVersionedDatabase`, with a store-specific message when a newer schema is
found) with three stores: `voices` (an `updatedAt` index), `audio`
(reference and sample WAVs, keyed by voice and role, with a `voiceId` index),
and `previews` (a bounded cache, 64 entries or 64 MiB, with `ownerId` and
`lastUsedAt` indexes). It holds presets, clones (a 24 kHz mono PCM16
reference and its exact transcript), and designed voices, with favorites and
tags, up to 500 voices. `createVoices` writes a batch in one transaction, so a
designed voice and its linked clone are saved together or not at all.

Voices export as `.voice.zip`: a `voice.json` manifest (format
`open-tts-voice`, version 1) plus `reference.wav` and/or `sample.wav`, each
checked against the manifest's byte length and SHA-256 on import. Import
rejects oversized files before reading them, then inspects the zip central
directory (at most 3 entries, allowed unique names, store or deflate only,
declared-size caps, a 200:1 expansion guard) and requires the audio to decode
as a WAV matching the manifest. Reference clips are never written to
`tts-engine-settings-v1`.

## Generation History

`open-tts-generation-history` (schema version 1) has an `entries` store
(`createdAt` and `lastAccessedAt` indexes) and an `audio` store. Studio saves a
completed generation with its text (up to 200,000 characters), engine, voice,
settings, seed, and audio, bounded to 200 entries and 512 MiB in total, with at
most 256 MiB per entry. Favorites have their own budget (at most 50 entries and
never more than the bytes left after reserving one maximum-size entry), so they
cannot make history unbounded; a save is refused rather than exceeding the
limits. Entries that cannot be parsed (corrupt, or written by a newer schema)
are skipped by eviction, and clearing history while keeping favorites leaves
newer-schema entries untouched. Variations and Dialogue sessions are not stored
here; the Dialogue script and manual casting persist in
`localStorage` (`open-tts:dialogue-session`).

## Settings and migrations

All keys live in `localStorage`, written and read through `src/lib/appState.ts`:

| Key | Contents |
|---|---|
| `tts-app-state-v2` | Selected model, text, quality, and `desktopModels` per surface (`studio`, `reader`) |
| `tts-engine-settings-v1` | Per-engine settings, each validated field by field by the engine descriptor's `parseSettings`; reference clips are never stored |
| `tts-app-creator-v2` | Creator settings: versioned, pronunciation dictionaries (v2), toggles for cleanup and normalization, export finishing options, caption style |
| `open-tts-reader-view-v1` | Reader appearance and preferences (including **Prepare the next part**) |
| `open-tts:dialogue-session` | Dialogue script and manual casting |

Migrations are read-once and non-destructive: `tts-app-state-v1` (and the
older `tts-app-model`) feed `tts-app-state-v2`, and `tts-app-creator-v1` feeds
`tts-app-creator-v2`, which moves the old pronunciation lines into a "Quick
rules" dictionary. The v1 keys are left in place. A lexicon that does not fit
the new limits (rules over 200 or 500 characters, or past 5,000 rules) is
filtered rule by rule rather than failing, and the Creator panel shows a
dismissible one-time notice. Browser model files are cached in Cache Storage
under `transformers-cache-kitten-v1`, `-paradee-v1`, and `-piper-v1` (Piper
holds every downloaded voice); the model-storage **Re-download** action deletes
the whole cache for these engines.

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
