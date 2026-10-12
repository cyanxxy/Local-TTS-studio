import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioExportOptions } from "../types";
import { createWavBlob } from "./audio";
import { measureLoudness } from "./audio/loudness";
import {
  LOUDNESS_PRESETS,
  buildExportAudio,
  downloadBlob,
  resolveMp3Bitrate,
  type ExportOptions,
  type ExportProgress,
} from "./exportAudio";

/** Bytes the mocked encoder returns from flush(); tests may change it. */
const flushBytes = vi.hoisted(() => ({ value: [3] }));

const encoderInstances = vi.hoisted(() => [] as Array<{
  channels: number;
  sampleRate: number;
  bitrate: number;
  encodeBuffer: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
}>);

vi.mock("@breezystack/lamejs", () => ({
  default: {
    Mp3Encoder: class {
      public channels: number;
      public sampleRate: number;
      public bitrate: number;
      // Like lamejs, short input may not complete an MP3 frame yet.
      public encodeBuffer = vi.fn((samples: Int16Array) => new Uint8Array(samples.length >= 100 ? [1, 2] : []));
      public flush = vi.fn(() => new Uint8Array(flushBytes.value));

      constructor(channels: number, sampleRate: number, bitrate: number) {
        this.channels = channels;
        this.sampleRate = sampleRate;
        this.bitrate = bitrate;
        encoderInstances.push(this);
      }
    },
  },
}));

const BASE_OPTIONS: AudioExportOptions = {
  format: "wav-f32",
  sampleRate: "source",
  bitrateKbps: 320,
  mastering: {
    enabled: false,
    targetLufs: -14,
    truePeakDb: -1,
  },
};

function sine(frequency: number, sampleRate: number, seconds: number, amplitude: number): Float32Array {
  const output = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < output.length; i += 1) output[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return output;
}

/** Quiet tone with sparse loud clicks: about a 20 dB peak-to-loudness ratio, like plosive-heavy speech. */
function crestySignal(sampleRate: number, seconds: number): Float32Array {
  const output = sine(220, sampleRate, seconds, 0.05);
  for (let i = 0; i < output.length; i += Math.round(sampleRate * 0.25)) {
    for (let j = 0; j < 24 && i + j < output.length; j += 1) output[i + j] += 0.5 * Math.sin((Math.PI * j) / 24);
  }
  return output;
}

async function decodeWav(blob: Blob): Promise<Float32Array> {
  return new Float32Array((await blob.arrayBuffer()).slice(44));
}

describe("buildExportAudio", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    encoderInstances.length = 0;
    flushBytes.value = [3];
  });

  it("rejects empty exports, invalid sample rates and unsupported formats", async () => {
    await expect(buildExportAudio([], BASE_OPTIONS)).rejects.toThrow("No audio");
    await expect(buildExportAudio([{ audio: new Float32Array([0, 0]), samplingRate: 0 }], BASE_OPTIONS))
      .rejects.toThrow("invalid sample rate: 0");
    await expect(buildExportAudio([{ audio: new Float32Array([0]), samplingRate: 24000 }], {
      ...BASE_OPTIONS,
      format: "aac" as AudioExportOptions["format"],
    })).rejects.toThrow("Unsupported export format");
  });

  it.each([
    ["wav-f32", "float32"],
    ["wav-pcm16", "pcm16"],
    ["wav-pcm24", "pcm24"],
  ] as const)("writes %s byte for byte like createWavBlob without processing", async (format, encoding) => {
    const chunks = [
      { audio: new Float32Array([0.1, -0.2, 1.5]), samplingRate: 24000 },
      { audio: new Float32Array([-1.5, 0.25]), samplingRate: 24000 },
    ];
    const result = await buildExportAudio(chunks, { ...BASE_OPTIONS, format });
    const expected = createWavBlob(chunks.map((chunk) => chunk.audio), 24000, { encoding });
    expect(result.extension).toBe("wav");
    expect(result.blob.type).toBe("audio/wav");
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(new Uint8Array(await expected.arrayBuffer()));
    expect(result.gainDb).toBe(0);
    expect(result.limiterReductionDb).toBe(0);
    expect(result.timings).toEqual([
      { startSec: 0, endSec: 3 / 24000, speechStartSec: 0, speechEndSec: 3 / 24000 },
      { startSec: 3 / 24000, endSec: 5 / 24000, speechStartSec: 3 / 24000, speechEndSec: 5 / 24000 },
    ]);
  });

  it("resamples continuously across chunks and converts chunks at other rates", async () => {
    const result = await buildExportAudio([
      { audio: sine(440, 24000, 0.5, 0.3), samplingRate: 24000 },
      { audio: sine(440, 48000, 0.5, 0.3), samplingRate: 48000 },
    ], { ...BASE_OPTIONS, sampleRate: 44100 });
    const audio = await decodeWav(result.blob);
    expect(audio.length).toBe(Math.round(24000 * 44100 / 24000));
    expect(result.report.durationSec).toBeCloseTo(1, 3);
    expect(result.report.samplePeakDbfs).toBeCloseTo(20 * Math.log10(0.3), 1);
  });

  it("masters a steady tone to the LUFS target", async () => {
    const result = await buildExportAudio([{ audio: sine(997, 24000, 4, 0.03), samplingRate: 24000 }], {
      ...BASE_OPTIONS,
      mastering: { enabled: true, targetLufs: -16, truePeakDb: -1 },
    });
    expect(result.report.integratedLufs).toBeCloseTo(-16, 1);
    expect(result.gainDb).toBeCloseTo(-16 - (-3.01 + 20 * Math.log10(0.03)), 1);
    expect(result.limiterReductionDb).toBe(0);
    expect(measureLoudness(await decodeWav(result.blob), 24000).integratedLufs).toBeCloseTo(-16, 1);
  });

  it("hits the target on high crest-factor audio by limiting peaks instead of lowering everything", async () => {
    const signal = crestySignal(24000, 6);
    const before = measureLoudness(signal, 24000);
    expect(before.truePeakDbtp - before.integratedLufs).toBeGreaterThan(15);
    const progress: ExportProgress[] = [];
    const result = await buildExportAudio([{ audio: signal, samplingRate: 24000 }], {
      ...BASE_OPTIONS,
      mastering: { enabled: true, targetLufs: -14, truePeakDb: -1 },
    }, { onProgress: (update) => progress.push(update) });
    expect(Math.abs(result.report.integratedLufs + 14)).toBeLessThanOrEqual(0.5);
    expect(result.report.truePeakDbtp).toBeLessThanOrEqual(-1 + 0.1);
    expect(result.limiterReductionDb).toBeGreaterThan(3);
    expect(progress.some((update) => update.phase === "analyzing")).toBe(true);
    expect(progress.at(-1)).toEqual({ phase: "encoding", fraction: 1 });
    progress.slice(1).forEach((update, index) => expect(update.fraction).toBeGreaterThanOrEqual(progress[index].fraction));
  });

  it("matches RMS for the ACX preset", async () => {
    const acx = LOUDNESS_PRESETS.find((preset) => preset.id === "acx");
    const result = await buildExportAudio([{ audio: crestySignal(24000, 4), samplingRate: 24000 }], {
      ...BASE_OPTIONS,
      mastering: { enabled: true, ...acx!.mastering },
    });
    expect(Math.abs(result.report.rmsDbfs + 20)).toBeLessThanOrEqual(0.5);
    expect(result.report.truePeakDbtp).toBeLessThanOrEqual(-3 + 0.1);
  });

  it("stops correcting once the limiter barely moves the level", async () => {
    // A steady tone boosted to -14 LUFS peaks near -11 dBTP, just over a -11.1 dB ceiling.
    const result = await buildExportAudio([{ audio: sine(997, 24000, 3, 0.05), samplingRate: 24000 }], {
      ...BASE_OPTIONS,
      mastering: { enabled: true, targetLufs: -14, truePeakDb: -11.1 },
    });
    expect(result.limiterReductionDb).toBeGreaterThan(0);
    expect(result.limiterReductionDb).toBeLessThan(0.5);
    expect(Math.abs(result.report.integratedLufs + 14)).toBeLessThanOrEqual(0.3);
  });

  it("exports empty chunks as an empty file", async () => {
    const progress: ExportProgress[] = [];
    const result = await buildExportAudio([{ audio: new Float32Array(0), samplingRate: 24000 }], BASE_OPTIONS, {
      onProgress: (update) => progress.push(update),
    });
    expect(result.blob.size).toBe(44);
    expect(progress.map((update) => update.fraction)).toEqual([1, 1]);
  });

  it("leaves silence alone when mastering", async () => {
    const result = await buildExportAudio([{ audio: new Float32Array(2400), samplingRate: 24000 }], {
      ...BASE_OPTIONS,
      format: "wav-pcm16",
      mastering: { enabled: true, targetLufs: -14, truePeakDb: -1 },
    });
    expect(result.gainDb).toBe(0);
    expect(result.report.integratedLufs).toBe(Number.NEGATIVE_INFINITY);
    expect(result.blob.size).toBe(44 + 2400 * 2);
  });

  it("post-processes chunks and reports the new timeline", async () => {
    const silence = new Float32Array(2400);
    const speech = sine(220, 24000, 0.5, 0.4);
    const audio = new Float32Array(silence.length * 3 + speech.length);
    audio.set(speech, silence.length);
    const result = await buildExportAudio([
      { audio, samplingRate: 24000, pauseAfterSec: 0.1 },
      { audio: speech, samplingRate: 24000 },
    ], { ...BASE_OPTIONS, post: { trimSilence: true, keepMs: 0, headSec: 0.2 } });
    expect(result.timings[0].speechStartSec).toBeCloseTo(0.2, 3);
    expect(result.timings[0].speechEndSec).toBeCloseTo(0.7, 2);
    expect(result.timings[1].startSec).toBeCloseTo(result.timings[0].endSec, 6);
    expect(result.report.durationSec).toBeCloseTo(0.2 + 0.5 + 0.1 + 0.5, 2);
  });

  it("encodes FLAC with a finished STREAMINFO block", async () => {
    const audio = sine(440, 24000, 0.3, 0.5);
    const result = await buildExportAudio([{ audio, samplingRate: 24000 }], { ...BASE_OPTIONS, format: "flac-16" });
    expect(result.extension).toBe("flac");
    expect(result.blob.type).toBe("audio/flac");
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("fLaC");
    // STREAMINFO: sample rate (20 bits) at byte 18, total samples in the low 36 bits of bytes 21-25.
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(18) >>> 12).toBe(24000);
    expect(((bytes[21] & 0x0f) * 2 ** 32) + view.getUint32(22)).toBe(audio.length);
    expect(bytes.subarray(26, 42).some((byte) => byte !== 0)).toBe(true);
    const deep = await buildExportAudio([{ audio, samplingRate: 24000 }], { ...BASE_OPTIONS, format: "flac-24" });
    expect(deep.blob.size).toBeGreaterThan(result.blob.size);
  });

  it("encodes MP3 in whole frames with an honest bitrate", async () => {
    const result = await buildExportAudio([{ audio: new Float32Array(1152 * 2 + 10), samplingRate: 24000 }], {
      ...BASE_OPTIONS,
      format: "mp3",
      bitrateKbps: 999,
    });
    expect(result).toMatchObject({ extension: "mp3" });
    expect(result.blob.type).toBe("audio/mpeg");
    expect(encoderInstances[0]).toMatchObject({ channels: 1, sampleRate: 24000, bitrate: 160 });
    expect(encoderInstances[0].encodeBuffer.mock.calls.map(([samples]) => samples.length)).toEqual([1152, 1152, 10]);
    expect(encoderInstances[0].flush).toHaveBeenCalledOnce();
    // Two full frames, a short final block that produced nothing yet, and the flush.
    expect(result.blob.size).toBe(2 + 2 + 1);
  });

  it("encodes MP3 input that ends on a frame boundary and an empty flush", async () => {
    flushBytes.value = [];
    const result = await buildExportAudio([{ audio: new Float32Array(1152), samplingRate: 48000 }], {
      ...BASE_OPTIONS,
      format: "mp3",
      metadata: { title: "Only metadata" },
    });
    expect(encoderInstances[0].encodeBuffer).toHaveBeenCalledOnce();
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(new TextDecoder("latin1").decode(bytes.subarray(0, 3))).toBe("ID3");
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("CHAP");
    expect(Array.from(bytes.subarray(bytes.length - 2))).toEqual([1, 2]);
  });

  it("tags MP3 exports with metadata and chapters on the exported timeline", async () => {
    const chunk = { audio: sine(220, 48000, 1, 0.2), samplingRate: 48000 };
    const result = await buildExportAudio([chunk, chunk, chunk], {
      ...BASE_OPTIONS,
      format: "mp3",
      metadata: { title: "Book", artist: "Narrator" },
      chapters: [
        { title: "One", chunkIndex: 0 },
        { title: "Two", chunkIndex: 2 },
        { title: "Missing", chunkIndex: 9 },
        { title: "Between", startSec: 1.7 },
        { title: "Unplaced" },
      ],
      post: { headSec: 0.5 },
    });
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const latin1 = new TextDecoder("latin1").decode(bytes);
    expect(latin1.slice(0, 3)).toBe("ID3");
    expect(new TextDecoder().decode(bytes)).toContain("Narrator");
    expect(latin1.match(/CHAP/g)).toHaveLength(3);
    // Each CHAP frame: 10-byte header, then its ID and a terminator, then start and end times in ms.
    const view = new DataView(bytes.buffer);
    const times = [...latin1.matchAll(/CHAP/g)].map((match) => {
      const idEnd = bytes.indexOf(0, match.index + 10);
      return [latin1.slice(match.index + 10, idEnd), view.getUint32(idEnd + 1), view.getUint32(idEnd + 5)];
    });
    // The first chapter covers the head padding; chunk 2 starts after 0.5 s of padding and two 1 s chunks.
    expect(times).toEqual([["ch0", 0, 1700], ["ch1", 1700, 2500], ["ch2", 2500, 3500]]);
    expect(encoderInstances[0].bitrate).toBe(320);
  });

  it("stops when the export is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(buildExportAudio([{ audio: new Float32Array(10), samplingRate: 24000 }], BASE_OPTIONS, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("resolveMp3Bitrate", () => {
  it.each([
    [24000, 999, 160],
    [24000, 128, 128],
    [44100, 999, 320],
    [48000, 32, 64],
    [48000, 96, 96],
    [48000, Number.NaN, 320],
  ])("at %i Hz turns %d kbps into %d kbps", (rate, requested, expected) => {
    expect(resolveMp3Bitrate(rate, requested)).toBe(expected);
  });
});

describe("LOUDNESS_PRESETS", () => {
  it("defines unique, sensible delivery targets", () => {
    expect(new Set(LOUDNESS_PRESETS.map((preset) => preset.id)).size).toBe(LOUDNESS_PRESETS.length);
    for (const preset of LOUDNESS_PRESETS) {
      expect(preset.mastering.targetLufs).toBeLessThan(0);
      expect(preset.mastering.truePeakDb).toBeLessThanOrEqual(-1);
    }
    expect(Object.isFrozen(LOUDNESS_PRESETS)).toBe(true);
    const options: ExportOptions = { ...BASE_OPTIONS, mastering: { enabled: true, ...LOUDNESS_PRESETS[0].mastering } };
    expect(options.mastering.targetLufs).toBe(-14);
  });
});

describe("downloadBlob", () => {
  it("downloads a blob and revokes its object URL", () => {
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    downloadBlob(new Blob(["audio"]), "speech.wav");

    const anchor = document.querySelector("a[download='speech.wav']") as HTMLAnchorElement | null;
    expect(anchor?.href).toBe("blob:test");
    expect(anchor?.rel).toBe("noopener");
    expect(click).toHaveBeenCalledOnce();

    vi.runAllTimers();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
    expect(document.querySelector("a[download='speech.wav']")).toBeNull();
    expect(createObjectURL).toHaveBeenCalledOnce();
  });
});
