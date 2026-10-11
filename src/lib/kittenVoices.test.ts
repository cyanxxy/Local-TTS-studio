import { describe, expect, it } from "vitest";
import {
  KITTEN_DEFAULT_VOICE,
  KITTEN_VOICES,
  KittenStyleTable,
  parseKittenConfig,
  parseKittenVoices,
  parseNpz,
  resolveKittenVoice,
} from "./kittenVoices";

interface NpzEntry {
  name: string;
  /** Raw .npy bytes; build them with npy(). */
  data: Uint8Array;
  method?: number;
  flags?: number;
  /** numpy writes ZIP64 placeholders (0xffffffff sizes plus a 20-byte extra) in local headers. */
  zip64Local?: boolean;
}

function npy(shape: number[], values?: ArrayLike<number>, header?: string, version = 1): Uint8Array {
  const count = shape.reduce((product, size) => product * size, 1);
  const headerStart = version === 1 ? 10 : 12;
  let dict = header ?? `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  const unpadded = headerStart + dict.length + 1;
  dict += " ".repeat((64 - (unpadded % 64)) % 64) + "\n";
  const bytes = new Uint8Array(headerStart + dict.length + count * 4);
  bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, version, 0]);
  if (version === 1) new DataView(bytes.buffer).setUint16(8, dict.length, true);
  else new DataView(bytes.buffer).setUint32(8, dict.length, true);
  bytes.set(new TextEncoder().encode(dict), headerStart);
  const view = new DataView(bytes.buffer, headerStart + dict.length);
  for (let index = 0; index < count; index += 1) view.setFloat32(index * 4, values?.[index] ?? index, true);
  return bytes;
}

/** A minimal stored ZIP, laid out the way numpy.savez writes it. */
function zip(entries: NpzEntry[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const extraLength = entry.zip64Local ? 20 : 0;
    const local = new Uint8Array(30 + name.length + extraLength + entry.data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 45, true);
    localView.setUint16(6, entry.flags ?? 0, true);
    localView.setUint16(8, entry.method ?? 0, true);
    localView.setUint32(18, entry.zip64Local ? 0xffffffff : entry.data.length, true);
    localView.setUint32(22, entry.zip64Local ? 0xffffffff : entry.data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, extraLength, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length + extraLength);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(8, entry.flags ?? 0, true);
    centralView.setUint16(10, entry.method ?? 0, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((sum, central) => sum + central.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  const archive = new Uint8Array(offset + directorySize + end.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return archive.buffer;
}

function voicesArchive(rows = 3): ArrayBuffer {
  return zip(KITTEN_VOICES.map((voice, voiceIndex) => ({
    name: `${voice.styleKey}.npy`,
    data: npy([rows, 256], Array.from({ length: rows * 256 }, (_, index) => voiceIndex * 1000 + index)),
    zip64Local: true,
  })));
}

function configBuffer(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}

const PINNED_CONFIG = {
  speed_priors: Object.fromEntries(KITTEN_VOICES.map((voice) => [voice.styleKey, voice.id === "Hugo" ? 0.9 : 0.8])),
  voice_aliases: Object.fromEntries(KITTEN_VOICES.map((voice) => [voice.id, voice.styleKey])),
};

describe("Kitten voice catalog", () => {
  it("lists the eight upstream aliases and resolves aliases, style keys and unknown ids", () => {
    expect(KITTEN_VOICES.map((voice) => voice.id)).toEqual(["Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"]);
    expect(KITTEN_DEFAULT_VOICE).toBe("Bella");
    expect(resolveKittenVoice("Hugo").styleKey).toBe("expr-voice-4-m");
    expect(resolveKittenVoice("expr-voice-5-f").id).toBe("Kiki");
    expect(resolveKittenVoice("af_heart").id).toBe("Bella");
  });
});

describe("parseNpz", () => {
  it("reads numpy's stored ZIP64-style entries using central directory sizes", () => {
    const arrays = parseNpz(zip([
      { name: "a.npy", data: npy([2, 3]), zip64Local: true },
      { name: "b.npy", data: npy([4], [1.5, -2, 0.25, 8]) },
    ]));

    expect(Array.from(arrays.keys())).toEqual(["a", "b"]);
    expect(arrays.get("a")).toEqual({ shape: [2, 3], data: new Float32Array([0, 1, 2, 3, 4, 5]) });
    expect(Array.from(arrays.get("b")!.data)).toEqual([1.5, -2, 0.25, 8]);
    expect(arrays.get("a")!.data.byteOffset).toBe(0);
  });

  it("accepts .npy format versions 2 and 3 and rejects unknown versions", () => {
    expect(parseNpz(zip([{ name: "a.npy", data: npy([2], [3, 4], undefined, 2) }])).get("a")!.data).toEqual(new Float32Array([3, 4]));
    expect(parseNpz(zip([{ name: "a.npy", data: npy([1], [5], undefined, 3) }])).get("a")!.data).toEqual(new Float32Array([5]));
    expect(() => parseNpz(zip([{ name: "a.npy", data: npy([1], [5], undefined, 4) }]))).toThrow("unsupported .npy version 4");
  });

  it.each([
    ["compressed entries", [{ name: "a.npy", data: npy([1]), method: 8 }], "is compressed"],
    ["encrypted entries", [{ name: "a.npy", data: npy([1]), flags: 1 }], "is encrypted"],
    ["non-npy entries", [{ name: "a.txt", data: npy([1]) }], "unexpected entry a.txt"],
    ["nested paths", [{ name: "dir/a.npy", data: npy([1]) }], "unexpected entry dir/a.npy"],
    ["duplicate names", [{ name: "a.npy", data: npy([1]) }, { name: "a.npy", data: npy([1]) }], "duplicate entry"],
    ["float64 arrays", [{ name: "a.npy", data: npy([1], undefined, "{'descr': '<f8', 'fortran_order': False, 'shape': (1,), }") }], "expected little-endian float32"],
    ["Fortran-order arrays", [{ name: "a.npy", data: npy([1], undefined, "{'descr': '<f4', 'fortran_order': True, 'shape': (1,), }") }], "C order"],
    ["missing shapes", [{ name: "a.npy", data: npy([1], undefined, "{'descr': '<f4', 'fortran_order': False, }") }], "has no shape"],
    ["empty shapes", [{ name: "a.npy", data: npy([1], undefined, "{'descr': '<f4', 'fortran_order': False, 'shape': (), }") }], "invalid shape"],
    ["shape/data mismatches", [{ name: "a.npy", data: npy([1], undefined, "{'descr': '<f4', 'fortran_order': False, 'shape': (2,), }") }], "data bytes"],
    ["non-npy payloads", [{ name: "a.npy", data: new Uint8Array(12) }], "is not an .npy array"],
  ] as const)("rejects %s", (_label, entries, message) => {
    expect(() => parseNpz(zip(entries.map((entry) => ({ ...entry }))))).toThrow(message);
  });

  it("rejects truncated archives and missing end records", () => {
    expect(() => parseNpz(new ArrayBuffer(10))).toThrow("truncated");
    expect(() => parseNpz(new ArrayBuffer(64))).toThrow("no end of central directory");
  });

  it("rejects archives whose directory points outside the file", () => {
    const archive = new Uint8Array(zip([{ name: "a.npy", data: npy([1]) }]));
    const view = new DataView(archive.buffer);
    view.setUint32(archive.length - 22 + 16, archive.length, true);

    expect(() => parseNpz(archive.buffer)).toThrow("out of bounds");
  });
});

describe("parseKittenVoices", () => {
  it("builds a style table per catalog voice and picks rows by text length", () => {
    const tables = parseKittenVoices(voicesArchive());
    const bella = tables.get("expr-voice-2-f")!;

    expect(tables.size).toBe(8);
    expect(bella.rows).toBe(3);
    expect(bella.styleFor(0)[0]).toBe(0);
    expect(bella.styleFor(1)[0]).toBe(256);
    // Upstream clamps to the last row: min(len(text), rows - 1).
    expect(bella.styleFor(399)[0]).toBe(512);
    expect(bella.styleFor(399)).toHaveLength(256);
    expect(tables.get("expr-voice-2-m")!.styleFor(0)[0]).toBe(1000);
  });

  it("returns a copy so a tensor can own the style row", () => {
    const table = parseKittenVoices(voicesArchive()).get("expr-voice-3-f")!;
    const style = table.styleFor(1);
    style[0] = -1;

    expect(table.styleFor(1)[0]).not.toBe(-1);
  });

  it("requires every catalog voice and a 256-wide table", () => {
    expect(() => parseKittenVoices(zip([{ name: "expr-voice-2-f.npy", data: npy([3, 256]) }]))).toThrow("no expr-voice-2-m table");
    expect(() => new KittenStyleTable({ shape: [3, 128], data: new Float32Array(384) }, "x")).toThrow("expected [rows, 256]");
  });
});

describe("parseKittenConfig", () => {
  it("reads per-voice speed priors from the pinned config", () => {
    expect(parseKittenConfig(configBuffer(PINNED_CONFIG)).speedPriors).toMatchObject({
      "expr-voice-4-m": 0.9,
      "expr-voice-2-f": 0.8,
    });
    expect(parseKittenConfig(configBuffer({ voice_aliases: PINNED_CONFIG.voice_aliases })).speedPriors).toEqual({});
  });

  it("rejects invalid JSON, mismatched aliases and invalid priors", () => {
    expect(() => parseKittenConfig(new TextEncoder().encode("{").buffer)).toThrow("invalid JSON");
    expect(() => parseKittenConfig(configBuffer({}))).toThrow("no voice_aliases");
    expect(() => parseKittenConfig(configBuffer({ voice_aliases: { ...PINNED_CONFIG.voice_aliases, Bella: "expr-voice-9-f" } })))
      .toThrow("maps Bella to an unexpected voice");
    expect(() => parseKittenConfig(configBuffer({ ...PINNED_CONFIG, speed_priors: 1 }))).toThrow("invalid speed_priors");
    expect(() => parseKittenConfig(configBuffer({ ...PINNED_CONFIG, speed_priors: { "expr-voice-2-f": 0 } })))
      .toThrow("invalid speed prior for expr-voice-2-f");
  });
});
