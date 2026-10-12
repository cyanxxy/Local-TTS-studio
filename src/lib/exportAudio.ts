import type { AudioExportOptions, ExportAudioFormat, MasteringOptions } from "../types";
import { buildWavHeader, floatToPcm16Array, floatToPcm16Sample, type WavEncoding } from "./audio";
import { FlacEncoder } from "./audio/flac";
import { buildId3Tag, chaptersFromStarts, type Id3Metadata } from "./audio/id3";
import { TruePeakLimiter } from "./audio/limiter";
import { LoudnessMeter, dbToGain, type LoudnessReport } from "./audio/loudness";
import { ChunkPostProcessor, type PostProcessTiming, type PostProcessingOptions } from "./audio/postProcess";
import { PolyphaseResampler, resampleAudio } from "./audio/resample";

/** Every export format: the persisted ones plus lossless FLAC. */
export type ExportFormat = ExportAudioFormat | "flac-16" | "flac-24";

export interface ExportChunk {
  audio: Float32Array;
  samplingRate: number;
  /** Silence the engine appended after the speech; post-processing keeps it exact. */
  pauseAfterSec?: number;
}

export interface ExportMasteringOptions extends MasteringOptions {
  /**
   * "lufs" (default) matches integrated loudness to `targetLufs`; "rms"
   * matches the unweighted RMS level instead, as ACX audiobook specs require.
   */
  measure?: "lufs" | "rms";
}

export interface ExportChapter {
  title: string;
  /** Start in the exported timeline, or `chunkIndex` to start where that chunk's audio starts. */
  startSec?: number;
  chunkIndex?: number;
}

export interface ExportOptions extends Omit<AudioExportOptions, "format" | "mastering"> {
  format: ExportFormat;
  mastering: ExportMasteringOptions;
  /** Edge-silence trimming, padding, fades and join de-clicking; omitted leaves chunks as generated. */
  post?: PostProcessingOptions;
  /** Tags written into MP3 exports (ID3v2.4). */
  metadata?: Omit<Id3Metadata, "durationMs">;
  /** Chapters written into MP3 exports. */
  chapters?: ExportChapter[];
}

export type ExportPhase = "analyzing" | "encoding";

export interface ExportProgress {
  phase: ExportPhase;
  /** Overall progress from 0 to 1. */
  fraction: number;
}

export interface ExportHooks {
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  extension: string;
  /** Measured on the exported audio. */
  report: LoudnessReport;
  /** Where each chunk landed in the exported timeline. */
  timings: PostProcessTiming[];
  /** Gain applied by mastering, in dB (0 without mastering). */
  gainDb: number;
  /** Deepest limiter gain reduction, in dB (0 when the limiter never engaged). */
  limiterReductionDb: number;
}

export interface LoudnessPreset {
  id: string;
  label: string;
  mastering: Omit<ExportMasteringOptions, "enabled">;
}

/** Common delivery targets. Podcasts: -16 LUFS stereo / -19 LUFS mono (Apple); ACX: RMS -20 dBFS, peaks -3 dB. */
export const LOUDNESS_PRESETS: readonly LoudnessPreset[] = Object.freeze([
  { id: "streaming", label: "Streaming (YouTube, Spotify) -14 LUFS", mastering: { targetLufs: -14, truePeakDb: -1 } },
  { id: "podcast", label: "Podcast -16 LUFS", mastering: { targetLufs: -16, truePeakDb: -1 } },
  { id: "podcast-mono", label: "Mono podcast -19 LUFS", mastering: { targetLufs: -19, truePeakDb: -1 } },
  { id: "ebu-r128", label: "Broadcast EBU R 128 -23 LUFS", mastering: { targetLufs: -23, truePeakDb: -1 } },
  { id: "atsc-a85", label: "Broadcast ATSC A/85 -24 LUFS", mastering: { targetLufs: -24, truePeakDb: -2 } },
  { id: "acx", label: "Audiobook (ACX) -20 dB RMS", mastering: { targetLufs: -20, truePeakDb: -3, measure: "rms" } },
]);

const FORMAT_EXTENSIONS: Readonly<Record<ExportFormat, string>> = {
  "wav-f32": "wav",
  "wav-pcm24": "wav",
  "wav-pcm16": "wav",
  mp3: "mp3",
  "flac-16": "flac",
  "flac-24": "flac",
};

const MIN_MP3_BITRATE_KBPS = 64;
const MAX_MP3_BITRATE_KBPS = 320;
/** Below 32 kHz MP3 is MPEG-2, which tops out at 160 kbps. */
const MAX_MPEG2_BITRATE_KBPS = 160;
const MP3_FRAME_SAMPLES = 1152;
/** Mastering stops correcting once within this many LU of the target. */
const MASTERING_TOLERANCE_LU = 0.3;
const MAX_MASTERING_CORRECTIONS = 2;

/** Bitrate an MP3 export really uses at `sampleRate`. */
export function resolveMp3Bitrate(sampleRate: number, requestedKbps: number): number {
  const max = sampleRate < 32000 ? MAX_MPEG2_BITRATE_KBPS : MAX_MP3_BITRATE_KBPS;
  const requested = Number.isFinite(requestedKbps) ? requestedKbps : max;
  return Math.round(Math.min(max, Math.max(MIN_MP3_BITRATE_KBPS, requested)));
}

function abortError(): DOMException {
  return new DOMException("The export was cancelled.", "AbortError");
}

// ---------------------------------------------------------------------------
// Encoders: each takes the final samples in order and builds the file at the end.

interface Encoder {
  write(samples: Float32Array): void;
  /** Builds the file; `outcome` describes the rendered audio (duration, timeline). */
  finish(outcome: RenderOutcome): Blob;
}

function wavEncoder(sampleRate: number, encoding: WavEncoding): Encoder {
  const parts: BlobPart[] = [];
  let frames = 0;
  return {
    write(samples) {
      frames += samples.length;
      if (encoding === "float32") {
        parts.push(samples.slice().buffer);
        return;
      }
      const bytes = encoding === "pcm16" ? 2 : 3;
      const view = new DataView(new ArrayBuffer(samples.length * bytes));
      for (let index = 0; index < samples.length; index += 1) {
        if (encoding === "pcm16") {
          view.setInt16(index * 2, floatToPcm16Sample(samples[index]), true);
        } else {
          const clamped = Math.max(-1, Math.min(1, samples[index]));
          const sample = clamped < 0 ? Math.round(clamped * 0x800000) : Math.round(clamped * 0x7fffff);
          view.setUint8(index * 3, sample & 0xff);
          view.setUint8(index * 3 + 1, (sample >> 8) & 0xff);
          view.setUint8(index * 3 + 2, (sample >> 16) & 0xff);
        }
      }
      parts.push(view.buffer);
    },
    finish() {
      return new Blob([buildWavHeader(frames, sampleRate, encoding), ...parts], { type: "audio/wav" });
    },
  };
}

interface Mp3EncoderLike {
  encodeBuffer(left: Int16Array): Uint8Array | Int8Array;
  flush(): Uint8Array | Int8Array;
}

function copyBytes(data: Uint8Array | Int8Array): ArrayBuffer {
  const bytes = new Uint8Array(data.length);
  bytes.set(data);
  return bytes.buffer;
}

function mp3Encoder(encoder: Mp3EncoderLike, id3Tag: (outcome: RenderOutcome) => Uint8Array | null): Encoder {
  const parts: BlobPart[] = [];
  let pending = new Float32Array(0);
  const encode = (samples: Float32Array) => {
    const encoded = encoder.encodeBuffer(floatToPcm16Array(samples));
    if (encoded.length > 0) parts.push(copyBytes(encoded));
  };
  return {
    write(samples) {
      const combined = new Float32Array(pending.length + samples.length);
      combined.set(pending);
      combined.set(samples, pending.length);
      const whole = combined.length - (combined.length % MP3_FRAME_SAMPLES);
      for (let offset = 0; offset < whole; offset += MP3_FRAME_SAMPLES) encode(combined.subarray(offset, offset + MP3_FRAME_SAMPLES));
      pending = combined.slice(whole);
    },
    finish(outcome) {
      if (pending.length > 0) encode(pending);
      const final = encoder.flush();
      if (final.length > 0) parts.push(copyBytes(final));
      const tag = id3Tag(outcome);
      return new Blob(tag ? [tag.slice().buffer, ...parts] : parts, { type: "audio/mpeg" });
    },
  };
}

function flacEncoder(sampleRate: number, bitsPerSample: 16 | 24): Encoder {
  const encoder = new FlacEncoder({ sampleRate, bitsPerSample });
  const parts: Uint8Array[] = [];
  return {
    write(samples) {
      parts.push(...encoder.encode(samples));
    },
    finish() {
      parts.push(...encoder.finish());
      // The first part is the marker plus the placeholder STREAMINFO.
      parts[0].set(encoder.streamInfo(), FlacEncoder.STREAMINFO_OFFSET);
      return new Blob(parts.map((part) => part.slice().buffer), { type: "audio/flac" });
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering

interface RenderSettings {
  gain: number;
  ceilingDb: number | null;
  /** Measure true peak (not needed for mastering trial passes). */
  truePeak?: boolean;
}

interface RenderOutcome {
  report: LoudnessReport;
  timings: PostProcessTiming[];
  limiterReductionDb: number;
}

/** Plain timings when chunks are exported as generated. */
function chunkTimings(chunks: readonly ExportChunk[], sampleRate: number): PostProcessTiming[] {
  let cursor = 0;
  return chunks.map((chunk) => {
    const length = chunk.audio.length;
    const pause = Math.min(length, Math.round(Math.max(0, chunk.pauseAfterSec ?? 0) * sampleRate));
    const timing = {
      startSec: cursor / sampleRate,
      endSec: (cursor + length) / sampleRate,
      speechStartSec: cursor / sampleRate,
      speechEndSec: (cursor + length - pause) / sampleRate,
    };
    cursor += length;
    return timing;
  });
}

/**
 * Streams every chunk through post-processing, resampling, gain and the
 * limiter into `sink`, measuring the result. Only one chunk's worth of
 * intermediate audio exists at a time.
 */
function render(
  chunks: readonly ExportChunk[],
  options: ExportOptions,
  settings: RenderSettings,
  targetRate: number,
  sink: ((samples: Float32Array) => void) | null,
  onChunk: (done: number) => void,
  signal: AbortSignal | undefined,
): RenderOutcome {
  const sourceRate = chunks[0].samplingRate;
  const post = options.post ? new ChunkPostProcessor(sourceRate, options.post) : null;
  const resampler = new PolyphaseResampler(sourceRate, targetRate);
  const limiter = settings.ceilingDb === null ? null : new TruePeakLimiter(targetRate, { ceilingDb: settings.ceilingDb });
  const meter = new LoudnessMeter(targetRate, { truePeak: settings.truePeak });

  const emit = (samples: Float32Array) => {
    if (samples.length === 0) return;
    if (settings.gain !== 1) {
      for (let index = 0; index < samples.length; index += 1) samples[index] *= settings.gain;
    }
    const limited = limiter ? limiter.process(samples) : samples;
    meter.process(limited);
    sink?.(limited);
  };

  let done = 0;
  for (const chunk of chunks) {
    if (signal?.aborted) throw abortError();
    const audio = chunk.samplingRate === sourceRate ? chunk.audio : resampleAudio(chunk.audio, chunk.samplingRate, sourceRate);
    const processed = post ? post.process({ audio, pauseAfterSec: chunk.pauseAfterSec }) : audio;
    emit(resampler.process(processed));
    done += chunk.audio.length;
    onChunk(done);
  }
  if (post) emit(resampler.process(post.flush()));
  emit(resampler.flush());
  if (limiter) {
    const tail = limiter.flush();
    meter.process(tail);
    sink?.(tail);
  }
  return {
    report: meter.result(),
    timings: post ? post.timings : chunkTimings(chunks, sourceRate),
    limiterReductionDb: limiter ? limiter.maxReductionDb : 0,
  };
}

function measuredLevel(report: LoudnessReport, measure: ExportMasteringOptions["measure"]): number {
  return measure === "rms" ? report.rmsDbfs : report.integratedLufs;
}

function validateChunks(chunks: readonly ExportChunk[]): void {
  if (chunks.length === 0) throw new Error("No audio is available to export.");
  for (const chunk of chunks) {
    if (!Number.isInteger(chunk.samplingRate) || chunk.samplingRate <= 0) {
      throw new Error(`Audio chunk has an invalid sample rate: ${chunk.samplingRate}.`);
    }
  }
}

/** Chapter starts on the exported timeline; a chapter at the first chunk also covers the head padding. */
function resolveChapterStarts(chapters: readonly ExportChapter[], timings: readonly PostProcessTiming[]) {
  return chapters.flatMap((chapter) => {
    const startSec = chapter.chunkIndex === 0
      ? 0
      : chapter.chunkIndex !== undefined ? timings[chapter.chunkIndex]?.startSec : chapter.startSec;
    return startSec === undefined ? [] : [{ title: chapter.title, startSec }];
  });
}

/**
 * Renders chunks into an audio file. Without mastering this is one streaming
 * pass. With mastering, a first pass measures the loudness, then gain and the
 * true-peak limiter are applied; when the limiter pulls the level more than
 * 0.3 LU off target, up to two correction passes refine the gain before the
 * final encoding pass.
 */
export async function buildExportAudio(
  chunks: ExportChunk[],
  options: ExportOptions,
  hooks: ExportHooks = {},
): Promise<ExportResult> {
  validateChunks(chunks);
  const format = options.format;
  if (!Object.hasOwn(FORMAT_EXTENSIONS, format)) throw new Error(`Unsupported export format: ${format}`);
  const targetRate = options.sampleRate === "source" ? chunks[0].samplingRate : options.sampleRate;
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.audio.length, 0);
  const mastering = options.mastering;
  const passes = mastering.enabled ? 2 + MAX_MASTERING_CORRECTIONS : 1;
  let passIndex = 0;
  const progress = (phase: ExportPhase) => (done: number) => {
    const fraction = totalSamples > 0 ? done / totalSamples : 1;
    hooks.onProgress?.({ phase, fraction: Math.min(1, (passIndex + fraction) / passes) });
  };

  let settings: RenderSettings = { gain: 1, ceilingDb: null };
  if (mastering.enabled) {
    const analysis = render(chunks, options, settings, targetRate, null, progress("analyzing"), hooks.signal);
    passIndex += 1;
    const measured = measuredLevel(analysis.report, mastering.measure);
    if (Number.isFinite(measured)) {
      let gainDb = mastering.targetLufs - measured;
      settings = { gain: dbToGain(gainDb), ceilingDb: mastering.truePeakDb };
      // The limiter only lowers the level when the boosted peaks exceed the ceiling.
      for (
        let correction = 0;
        correction < MAX_MASTERING_CORRECTIONS && analysis.report.truePeakDbtp + gainDb > mastering.truePeakDb;
        correction += 1
      ) {
        const trial = render(chunks, options, { ...settings, truePeak: false }, targetRate, null, progress("analyzing"), hooks.signal);
        passIndex += 1;
        const error = mastering.targetLufs - measuredLevel(trial.report, mastering.measure);
        if (Math.abs(error) <= MASTERING_TOLERANCE_LU) break;
        gainDb += error;
        settings = { gain: dbToGain(gainDb), ceilingDb: mastering.truePeakDb };
      }
    }
    passIndex = passes - 1;
  }

  const id3Tag = (outcome: RenderOutcome): Uint8Array | null => {
    if (!options.metadata && !options.chapters?.length) return null;
    const { durationSec } = outcome.report;
    const chapters = chaptersFromStarts(resolveChapterStarts(options.chapters ?? [], outcome.timings), durationSec);
    return buildId3Tag({ ...options.metadata, durationMs: durationSec * 1000 }, chapters);
  };

  let encoder: Encoder;
  switch (format) {
    case "wav-f32":
      encoder = wavEncoder(targetRate, "float32");
      break;
    case "wav-pcm24":
      encoder = wavEncoder(targetRate, "pcm24");
      break;
    case "wav-pcm16":
      encoder = wavEncoder(targetRate, "pcm16");
      break;
    case "flac-16":
      encoder = flacEncoder(targetRate, 16);
      break;
    case "flac-24":
      encoder = flacEncoder(targetRate, 24);
      break;
    default: {
      const lamejs = await import("@breezystack/lamejs");
      const mp3 = new lamejs.default.Mp3Encoder(1, targetRate, resolveMp3Bitrate(targetRate, options.bitrateKbps));
      encoder = mp3Encoder(mp3, id3Tag);
    }
  }

  const outcome = render(chunks, options, settings, targetRate, (samples) => encoder.write(samples), progress("encoding"), hooks.signal);
  const blob = encoder.finish(outcome);
  hooks.onProgress?.({ phase: "encoding", fraction: 1 });
  return {
    blob,
    extension: FORMAT_EXTENSIONS[format],
    report: outcome.report,
    timings: outcome.timings,
    gainDb: settings.gain === 1 ? 0 : 20 * Math.log10(settings.gain),
    limiterReductionDb: outcome.limiterReductionDb,
  };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 0);
}
