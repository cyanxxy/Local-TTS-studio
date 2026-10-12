/**
 * Kitten TTS 0.8 voices: the friendly catalog, a strict reader for the pinned
 * voices.npz style tables, and config.json's aliases and speed priors.
 */

export interface KittenVoice {
  /** The id the app sends and READY lists: the upstream friendly alias. */
  id: string;
  /** The voices.npz table the alias resolves to. */
  styleKey: string;
  gender: "female" | "male";
}

/** Upstream config.json voice_aliases order. */
export const KITTEN_VOICES: readonly KittenVoice[] = [
  { id: "Bella", styleKey: "expr-voice-2-f", gender: "female" },
  { id: "Jasper", styleKey: "expr-voice-2-m", gender: "male" },
  { id: "Luna", styleKey: "expr-voice-3-f", gender: "female" },
  { id: "Bruno", styleKey: "expr-voice-3-m", gender: "male" },
  { id: "Rosie", styleKey: "expr-voice-4-f", gender: "female" },
  { id: "Hugo", styleKey: "expr-voice-4-m", gender: "male" },
  { id: "Kiki", styleKey: "expr-voice-5-f", gender: "female" },
  { id: "Leo", styleKey: "expr-voice-5-m", gender: "male" },
];
export const KITTEN_DEFAULT_VOICE = KITTEN_VOICES[0].id;
export const KITTEN_STYLE_DIMENSION = 256;

/** Resolve an alias or a raw style key; anything unknown falls back to the default voice. */
export function resolveKittenVoice(voice: string): KittenVoice {
  return KITTEN_VOICES.find((entry) => entry.id === voice || entry.styleKey === voice) ?? KITTEN_VOICES[0];
}

export interface NpyFloat32Array {
  shape: number[];
  data: Float32Array;
}

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_UINT32_SENTINEL = 0xffffffff;
const ZIP_UINT16_SENTINEL = 0xffff;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;
const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // "\x93NUMPY"

function npzError(message: string): Error {
  return new Error(`Invalid voices.npz: ${message}`);
}

function findEndOfCentralDirectory(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - 22 - ZIP_MAX_COMMENT_LENGTH);
  for (let offset = view.byteLength - 22; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw npzError("no end of central directory record.");
}

function parseNpy(bytes: Uint8Array, name: string): NpyFloat32Array {
  if (bytes.byteLength < 10 || NPY_MAGIC.some((value, index) => bytes[index] !== value)) {
    throw npzError(`${name} is not an .npy array.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  if (major < 1 || major > 3) throw npzError(`${name} uses unsupported .npy version ${major}.`);
  const headerStart = major === 1 ? 10 : 12;
  if (bytes.byteLength < headerStart) throw npzError(`${name} is truncated.`);
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const dataStart = headerStart + headerLength;
  if (dataStart > bytes.byteLength) throw npzError(`${name} has a truncated header.`);

  const header = new TextDecoder(major === 3 ? "utf-8" : "latin1").decode(bytes.subarray(headerStart, dataStart));
  const descr = /'descr':\s*'([^']*)'/.exec(header)?.[1];
  const fortranOrder = /'fortran_order':\s*(True|False)/.exec(header)?.[1];
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1];
  if (descr !== "<f4") throw npzError(`${name} has dtype ${descr ?? "unknown"}; expected little-endian float32.`);
  if (fortranOrder !== "False") throw npzError(`${name} must be stored in C order.`);
  if (shapeText === undefined) throw npzError(`${name} has no shape.`);
  const shape = shapeText.split(",").map((part) => part.trim()).filter(Boolean).map(Number);
  if (shape.length === 0 || shape.some((size) => !Number.isSafeInteger(size) || size < 1)) {
    throw npzError(`${name} has an invalid shape (${shapeText}).`);
  }

  const elementCount = shape.reduce((product, size) => product * size, 1);
  if (bytes.byteLength - dataStart !== elementCount * 4) {
    throw npzError(`${name} holds ${bytes.byteLength - dataStart} data bytes; its shape needs ${elementCount * 4}.`);
  }
  // Decode explicitly as little-endian; this also copies out of the archive
  // into an aligned buffer the tables own.
  const data = new Float32Array(elementCount);
  for (let index = 0; index < elementCount; index += 1) {
    data[index] = view.getFloat32(dataStart + index * 4, true);
  }
  return { shape, data };
}

/**
 * Read every array from an .npz archive. Only what numpy.savez writes is
 * accepted: stored (uncompressed), unencrypted, single-disk entries named
 * *.npy holding C-order little-endian float32. The archive's bytes are
 * SHA-256 verified before they get here, so the per-entry CRC is not rechecked.
 */
export function parseNpz(buffer: ArrayBuffer): Map<string, NpyFloat32Array> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.byteLength < 22) throw npzError("the archive is truncated.");
  const end = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) !== entryCount) {
    throw npzError("multi-disk archives are not supported.");
  }
  if (entryCount === ZIP_UINT16_SENTINEL || directoryOffset === ZIP_UINT32_SENTINEL || directorySize === ZIP_UINT32_SENTINEL) {
    throw npzError("ZIP64 archives are not supported.");
  }
  if (directoryOffset + directorySize > end) throw npzError("the central directory is out of bounds.");

  const arrays = new Map<string, NpyFloat32Array>();
  let cursor = directoryOffset;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== ZIP_CENTRAL_DIRECTORY_ENTRY) {
      throw npzError("a central directory entry is malformed.");
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (cursor + 46 + nameLength > end) throw npzError("an entry name is out of bounds.");
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw npzError(`${name} is encrypted.`);
    if (method !== 0 || compressedSize !== size) throw npzError(`${name} is compressed; expected a stored entry.`);
    if (size === ZIP_UINT32_SENTINEL || localOffset === ZIP_UINT32_SENTINEL) {
      throw npzError(`${name} needs ZIP64 sizes, which are not supported.`);
    }
    if (!name.endsWith(".npy") || name.includes("/")) throw npzError(`unexpected entry ${name}.`);
    const key = name.slice(0, -".npy".length);
    if (arrays.has(key)) throw npzError(`duplicate entry ${name}.`);

    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE_HEADER) {
      throw npzError(`${name} has no local file header.`);
    }
    if (view.getUint16(localOffset + 8, true) !== 0) throw npzError(`${name} is compressed; expected a stored entry.`);
    // numpy writes ZIP64 placeholders in the local header, so its sizes come
    // from the central directory; only the name and extra lengths are read here.
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataStart + size > directoryOffset) throw npzError(`${name} is out of bounds.`);
    arrays.set(key, parseNpy(bytes.subarray(dataStart, dataStart + size), name));
  }
  if (cursor !== directoryOffset + directorySize) throw npzError("the central directory size does not match its entries.");
  return arrays;
}

/** One voice's [rows, 256] style table. Kitten picks the row from the chunk's character count. */
export class KittenStyleTable {
  readonly rows: number;
  private readonly data: Float32Array;

  constructor(array: NpyFloat32Array, name: string) {
    if (array.shape.length !== 2 || array.shape[1] !== KITTEN_STYLE_DIMENSION) {
      throw new Error(`Kitten voice ${name} has shape [${array.shape.join(", ")}]; expected [rows, ${KITTEN_STYLE_DIMENSION}].`);
    }
    this.rows = array.shape[0];
    this.data = array.data;
  }

  /** Upstream: style row = min(len(text), rows - 1). Returns a copy the caller may hand to a tensor. */
  styleFor(textLength: number): Float32Array {
    const row = Math.max(0, Math.min(Math.floor(textLength), this.rows - 1));
    return this.data.slice(row * KITTEN_STYLE_DIMENSION, (row + 1) * KITTEN_STYLE_DIMENSION);
  }
}

/** Build the style tables for every catalog voice; a missing voice is an error. */
export function parseKittenVoices(buffer: ArrayBuffer): Map<string, KittenStyleTable> {
  const arrays = parseNpz(buffer);
  const tables = new Map<string, KittenStyleTable>();
  for (const voice of KITTEN_VOICES) {
    const array = arrays.get(voice.styleKey);
    if (!array) throw new Error(`voices.npz has no ${voice.styleKey} table.`);
    tables.set(voice.styleKey, new KittenStyleTable(array, voice.styleKey));
  }
  return tables;
}

export interface KittenConfig {
  /** Multiplies the requested speed per style key (0.8-0.9 on nano); 1 when absent. */
  speedPriors: Record<string, number>;
}

/** Parse config.json and check its aliases agree with the built-in catalog. */
export function parseKittenConfig(buffer: ArrayBuffer): KittenConfig {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new Error("Kitten config.json is invalid JSON.");
  }
  const config = value as { voice_aliases?: unknown; speed_priors?: unknown } | null;
  const aliases = config?.voice_aliases;
  if (!aliases || typeof aliases !== "object") throw new Error("Kitten config.json has no voice_aliases.");
  for (const voice of KITTEN_VOICES) {
    if ((aliases as Record<string, unknown>)[voice.id] !== voice.styleKey) {
      throw new Error(`Kitten config.json maps ${voice.id} to an unexpected voice.`);
    }
  }
  const speedPriors: Record<string, number> = {};
  const priors = config?.speed_priors;
  if (priors !== undefined) {
    if (!priors || typeof priors !== "object") throw new Error("Kitten config.json has invalid speed_priors.");
    for (const [styleKey, prior] of Object.entries(priors)) {
      if (typeof prior !== "number" || !Number.isFinite(prior) || prior <= 0) {
        throw new Error(`Kitten config.json has an invalid speed prior for ${styleKey}.`);
      }
      speedPriors[styleKey] = prior;
    }
  }
  return { speedPriors };
}
