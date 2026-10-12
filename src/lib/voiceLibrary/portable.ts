import { decodeWav } from "../wavCodec";
import type { NewVoice, StoredAudioInfo, VoiceRecord } from "./types";
import {
  VOICE_LIBRARY_LIMITS,
  VoiceLibraryValidationError,
  normalizeStoredAudioInfo,
} from "./validation";

/**
 * A portable voice is a zip holding `voice.json` (the manifest) plus the
 * voice's audio as `reference.wav` (cloned voices) or `sample.wav` (designed
 * voices). The zip code is loaded on demand so it stays out of the entry chunk.
 */

export const VOICE_PACKAGE_FORMAT = "open-tts-voice";
export const VOICE_PACKAGE_VERSION = 1;
export const VOICE_PACKAGE_EXTENSION = ".voice.zip";
const MANIFEST_FILE = "voice.json";
const REFERENCE_FILE = "reference.wav";
const SAMPLE_FILE = "sample.wav";
const MAX_MANIFEST_BYTES = 64 * 1024;
/** Two WAVs at the audio cap plus the manifest and zip overhead. */
export const MAX_VOICE_PACKAGE_BYTES = 2 * VOICE_LIBRARY_LIMITS.maxAudioBytes + MAX_MANIFEST_BYTES + 64 * 1024;

const ALLOWED_FILES: Readonly<Record<string, number>> = {
  [MANIFEST_FILE]: MAX_MANIFEST_BYTES,
  [REFERENCE_FILE]: VOICE_LIBRARY_LIMITS.maxAudioBytes,
  [SAMPLE_FILE]: VOICE_LIBRARY_LIMITS.maxAudioBytes,
};

/** A voice package holds at most a manifest and two WAVs. */
const MAX_ZIP_ENTRIES = 3;
/** Deflate seldom beats 10:1 on a manifest; anything past this is a zip bomb, not a voice. */
const MAX_COMPRESSION_RATIO = 200;
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL_ENTRY = 0x02014b50;

function fail(message: string): never {
  throw new VoiceLibraryValidationError(message);
}

/** A file-system-safe name such as `Warm narrator.voice.zip`. */
export function voicePackageFileName(name: string): string {
  // Control characters and characters Windows forbids in file names.
  const replaced = Array.from(name, (character) => (
    character.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(character) ? " " : character
  )).join("");
  const safe = replaced
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return `${safe || "voice"}${VOICE_PACKAGE_EXTENSION}`;
}

function manifestVoice(record: VoiceRecord): Record<string, unknown> {
  const common = {
    kind: record.kind,
    name: record.name,
    description: record.description,
    tags: record.tags,
  };
  switch (record.kind) {
    case "preset":
      return { ...common, preset: record.preset };
    case "cloned":
      return {
        ...common,
        transcript: record.transcript,
        language: record.language,
        targets: record.targets,
        source: record.source,
        reference: record.reference,
      };
    case "designed":
      return { ...common, design: record.design, ...(record.sample ? { sample: record.sample } : {}) };
  }
}

/** Zip a voice and its audio. Ids, favorites and timestamps stay local. */
export async function buildVoicePackage(
  record: VoiceRecord,
  audio: { reference?: Uint8Array | null; sample?: Uint8Array | null },
  exportedAt: number,
): Promise<Uint8Array> {
  const { zipSync, strToU8 } = await import("fflate");
  const manifest = {
    format: VOICE_PACKAGE_FORMAT,
    version: VOICE_PACKAGE_VERSION,
    exportedAt: new Date(exportedAt).toISOString(),
    voice: manifestVoice(record),
  };
  // WAV barely compresses, so store it and only deflate the manifest.
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    [MANIFEST_FILE]: [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }],
  };
  if (record.kind === "cloned") {
    if (!audio.reference) throw new Error("A cloned voice needs its reference audio to export.");
    files[REFERENCE_FILE] = [audio.reference, { level: 0 }];
  }
  if (record.kind === "designed" && record.sample) {
    if (!audio.sample) throw new Error("This designed voice's sample is missing.");
    files[SAMPLE_FILE] = [audio.sample, { level: 0 }];
  }
  return zipSync(files);
}

/**
 * Check the zip's central directory before inflating anything: how many
 * entries it has, whether each name is allowed and unique, and whether any
 * entry claims to expand by an implausible factor. This reads only the
 * directory, so a hostile archive costs nothing to refuse.
 */
function inspectZipDirectory(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  // The end-of-central-directory record is within 64 KiB + 22 bytes of the end.
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 22 - 0xffff); offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD) { eocd = offset; break; }
  }
  if (eocd < 0) fail("The voice file is not a valid zip archive.");
  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff) fail("The voice file is not a valid zip archive.");
  if (count > MAX_ZIP_ENTRIES) fail(`The voice file has too many entries (at most ${MAX_ZIP_ENTRIES}).`);
  const seen = new Set<string>();
  let offset = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_ENTRY) {
      fail("The voice file is not a valid zip archive.");
    }
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const original = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (offset + 46 + nameLength > bytes.byteLength) fail("The voice file is not a valid zip archive.");
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!Object.hasOwn(ALLOWED_FILES, name)) fail(`The voice file contains an unexpected entry (${name.slice(0, 40)}).`);
    if (seen.has(name)) fail(`The voice file lists ${name} more than once.`);
    seen.add(name);
    if (method !== 0 && method !== 8) fail("The voice file uses an unsupported compression method.");
    if (original > ALLOWED_FILES[name]) fail(`${name} in the voice file is too large.`);
    if (method === 0 && compressed !== original) fail("The voice file is not a valid zip archive.");
    if (method === 8 && original > 64 * 1024 && original > Math.max(1, compressed) * MAX_COMPRESSION_RATIO) {
      fail(`${name} in the voice file expands suspiciously; it was not made by Open TTS.`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function verifiedAudio(
  files: Record<string, Uint8Array>,
  fileName: string,
  declared: unknown,
  digest: (bytes: Uint8Array) => Promise<string>,
): Promise<Uint8Array> {
  const bytes = files[fileName];
  if (!bytes) fail(`The voice file is missing ${fileName}.`);
  const info: StoredAudioInfo = normalizeStoredAudioInfo(declared);
  if (bytes.byteLength !== info.byteLength || await digest(bytes) !== info.sha256) {
    fail(`${fileName} does not match the voice manifest; the file may be damaged.`);
  }
  // The audio must really be a WAV that agrees with what the manifest says.
  try {
    const decoded = decodeWav(bytes);
    const seconds = decoded.channels[0].length / decoded.sampleRate;
    if (decoded.sampleRate !== info.sampleRate || Math.abs(seconds - info.durationSec) > 0.05) throw new Error("mismatch");
  } catch {
    fail(`${fileName} is not valid audio, or does not match the voice manifest.`);
  }
  return bytes;
}

/**
 * Read a voice package into library input. Entries are filtered by name and
 * declared size before inflating, so a hostile zip cannot allocate more than
 * the library would ever store, and audio is checked against the manifest's
 * size and SHA-256. Field validation happens again when the voice is saved.
 */
export async function parseVoicePackage(
  bytes: Uint8Array,
  digest: (bytes: Uint8Array) => Promise<string>,
): Promise<NewVoice> {
  if (bytes.byteLength > MAX_VOICE_PACKAGE_BYTES) fail("The voice file is too large.");
  const { unzipSync, strFromU8 } = await import("fflate");
  inspectZipDirectory(bytes);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => Object.hasOwn(ALLOWED_FILES, file.name) && file.originalSize <= ALLOWED_FILES[file.name],
    });
  } catch {
    fail("The voice file is not a valid zip archive.");
  }
  // Stored (uncompressed) entries are sliced by their compressed size, which
  // the filter cannot see, so re-check what was actually extracted.
  for (const [name, content] of Object.entries(files)) {
    if (content.byteLength > ALLOWED_FILES[name]) fail(`${name} in the voice file is too large.`);
  }
  const manifestBytes = files[MANIFEST_FILE];
  if (!manifestBytes) fail("The voice file has no voice.json manifest.");

  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes));
  } catch {
    fail("The voice manifest is not valid JSON.");
  }
  if (!isRecord(manifest) || manifest.format !== VOICE_PACKAGE_FORMAT) fail("This is not an Open TTS voice file.");
  if (typeof manifest.version !== "number" || manifest.version > VOICE_PACKAGE_VERSION) {
    fail("This voice file was made by a newer version of Open TTS.");
  }
  const voice = manifest.voice;
  if (!isRecord(voice)) fail("The voice manifest has no voice.");
  // Each kind carries exactly the audio it needs, nothing else.
  const expectsReference = voice.kind === "cloned";
  const expectsSample = voice.kind === "designed" && voice.sample !== undefined;
  if (REFERENCE_FILE in files && !expectsReference) fail("The voice file contains audio this voice does not use.");
  if (SAMPLE_FILE in files && !expectsSample) fail("The voice file contains audio this voice does not use.");

  const common = {
    name: voice.name as string,
    description: voice.description as string | undefined,
    tags: voice.tags as string[] | undefined,
  };
  switch (voice.kind) {
    case "preset":
      return { ...common, kind: "preset", preset: voice.preset as Extract<NewVoice, { kind: "preset" }>["preset"] };
    case "cloned":
      return {
        ...common,
        kind: "cloned",
        transcript: voice.transcript as string,
        language: voice.language as string | undefined,
        targets: voice.targets as Extract<NewVoice, { kind: "cloned" }>["targets"],
        source: voice.source as Extract<NewVoice, { kind: "cloned" }>["source"],
        referenceWav: await verifiedAudio(files, REFERENCE_FILE, voice.reference, digest),
      };
    case "designed":
      return {
        ...common,
        kind: "designed",
        design: voice.design as Extract<NewVoice, { kind: "designed" }>["design"],
        ...(voice.sample === undefined
          ? {}
          : { sampleWav: await verifiedAudio(files, SAMPLE_FILE, voice.sample, digest) }),
      };
    default:
      fail("The voice file has an unknown voice kind.");
  }
}
