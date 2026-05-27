import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioExportOptions } from "../types";
import { buildExportAudio, downloadBlob } from "./exportAudio";

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
      public encodeBuffer = vi.fn(() => new Uint8Array([1, 2]));
      public flush = vi.fn(() => new Uint8Array([3]));

      constructor(
        channels: number,
        sampleRate: number,
        bitrate: number,
      ) {
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

describe("exportAudio", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    encoderInstances.length = 0;
  });

  it("rejects empty exports", async () => {
    await expect(buildExportAudio([], BASE_OPTIONS)).rejects.toThrow("No audio");
  });

  it("builds float and PCM WAV blobs from source or resampled audio", async () => {
    const f32 = await buildExportAudio([
      { audio: new Float32Array([0.1, -0.2]), samplingRate: 4 },
    ], BASE_OPTIONS);

    expect(f32.extension).toBe("wav");
    expect(f32.blob.type).toBe("audio/wav");
    expect(f32.blob.size).toBe(44 + 2 * 4);

    const pcm16 = await buildExportAudio([
      { audio: new Float32Array([0, 1]), samplingRate: 22050 },
    ], {
      ...BASE_OPTIONS,
      format: "wav-pcm16",
      sampleRate: 44100,
      mastering: { enabled: true, targetLufs: -12, truePeakDb: -3 },
    });

    expect(pcm16.blob.size).toBe(44 + 4 * 2);

    const pcm24 = await buildExportAudio([
      { audio: new Float32Array([0.25, -0.25]), samplingRate: 4 },
    ], {
      ...BASE_OPTIONS,
      format: "wav-pcm24",
    });

    expect(pcm24.blob.size).toBe(44 + 2 * 3);
  });

  it("returns original audio for invalid resample rates and silence mastering", async () => {
    const result = await buildExportAudio([
      { audio: new Float32Array([0, 0]), samplingRate: 0 },
    ], {
      ...BASE_OPTIONS,
      format: "wav-pcm16",
      sampleRate: 44100,
      mastering: { enabled: true, targetLufs: -14, truePeakDb: -1 },
    });

    expect(result.blob.size).toBe(44 + 2 * 2);
  });

  it("encodes mp3 with clamped bitrate and final flush chunk", async () => {
    const result = await buildExportAudio([
      { audio: new Float32Array([2, -2, 0.5]), samplingRate: 24000 },
    ], {
      ...BASE_OPTIONS,
      format: "mp3",
      bitrateKbps: 999,
    });

    expect(result).toMatchObject({ extension: "mp3" });
    expect(result.blob.type).toBe("audio/mpeg");
    expect(result.blob.size).toBe(3);
    expect(encoderInstances[0]).toMatchObject({
      channels: 1,
      sampleRate: 24000,
      bitrate: 320,
    });
    expect(encoderInstances[0].encodeBuffer).toHaveBeenCalledOnce();
    expect(encoderInstances[0].flush).toHaveBeenCalledOnce();
  });

  it("clamps mp3 bitrate to the UI-supported floor", async () => {
    await buildExportAudio([
      { audio: new Float32Array([0, 0.5]), samplingRate: 24000 },
    ], {
      ...BASE_OPTIONS,
      format: "mp3",
      bitrateKbps: 96,
    });

    expect(encoderInstances[0]).toMatchObject({
      bitrate: 128,
    });
  });

  it("rejects unsupported export formats", async () => {
    await expect(buildExportAudio([
      { audio: new Float32Array([0]), samplingRate: 24000 },
    ], {
      ...BASE_OPTIONS,
      format: "aac" as AudioExportOptions["format"],
    })).rejects.toThrow("Unsupported export format");
  });

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
