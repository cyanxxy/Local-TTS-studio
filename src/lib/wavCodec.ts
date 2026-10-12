import { buildWavHeader, floatToPcm16Sample } from "./audio";

/**
 * Decode and encode RIFF/WAVE bytes without Web Audio, so reference clips,
 * recordings and saved voices can be analyzed and rewritten in workers, tests
 * and the Electron renderer alike.
 */

export interface DecodedWav {
  sampleRate: number;
  /** One Float32Array per channel, de-interleaved, in [-1, 1]. */
  channels: Float32Array[];
  bitsPerSample: number;
  /** 1 = integer PCM, 3 = IEEE float. Extensible headers report their subformat. */
  formatCode: 1 | 3;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const MAX_CHANNELS = 32;

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function toDataView(bytes: ArrayBuffer | Uint8Array): DataView {
  return bytes instanceof Uint8Array
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new DataView(bytes);
}

interface WavFormat {
  formatCode: 1 | 3;
  channelCount: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
}

function parseFormat(view: DataView, offset: number, size: number): WavFormat {
  if (size < 16) throw new Error("WAV fmt chunk is too short.");
  let formatCode = view.getUint16(offset, true);
  const channelCount = view.getUint16(offset + 2, true);
  const sampleRate = view.getUint32(offset + 4, true);
  const blockAlign = view.getUint16(offset + 12, true);
  const bitsPerSample = view.getUint16(offset + 14, true);
  if (formatCode === WAVE_FORMAT_EXTENSIBLE) {
    // The subformat GUID starts with the real format code.
    if (size < 40) throw new Error("WAV extensible fmt chunk is too short.");
    formatCode = view.getUint16(offset + 24, true);
  }
  if (formatCode !== WAVE_FORMAT_PCM && formatCode !== WAVE_FORMAT_IEEE_FLOAT) {
    throw new Error("Only PCM and IEEE float WAV files are supported.");
  }
  if (channelCount < 1 || channelCount > MAX_CHANNELS) {
    throw new Error("WAV channel count is out of range.");
  }
  if (sampleRate < 1) throw new Error("WAV sample rate is invalid.");
  const supported = formatCode === WAVE_FORMAT_PCM
    ? [8, 16, 24, 32].includes(bitsPerSample)
    : [32, 64].includes(bitsPerSample);
  if (!supported) throw new Error(`${bitsPerSample}-bit WAV samples are not supported.`);
  if (blockAlign !== channelCount * (bitsPerSample / 8)) {
    throw new Error("WAV block alignment does not match its sample format.");
  }
  return { formatCode, channelCount, sampleRate, bitsPerSample, blockAlign };
}

function readSample(view: DataView, offset: number, format: WavFormat): number {
  if (format.formatCode === WAVE_FORMAT_IEEE_FLOAT) {
    const value = format.bitsPerSample === 32
      ? view.getFloat32(offset, true)
      : view.getFloat64(offset, true);
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  }
  switch (format.bitsPerSample) {
    case 8:
      // 8-bit WAV is the one unsigned PCM width.
      return (view.getUint8(offset) - 128) / 128;
    case 16:
      return view.getInt16(offset, true) / 0x8000;
    case 24: {
      const low = view.getUint8(offset) | (view.getUint8(offset + 1) << 8);
      const value = (view.getInt8(offset + 2) << 16) | low;
      return value / 0x800000;
    }
    default:
      return view.getInt32(offset, true) / 0x80000000;
  }
}

/**
 * Decode a WAV file. Unknown chunks are skipped, and a `data` chunk that
 * declares more bytes than the file holds (a truncated or streamed file) is
 * read up to the last complete frame.
 */
export function decodeWav(bytes: ArrayBuffer | Uint8Array): DecodedWav {
  const view = toDataView(bytes);
  if (view.byteLength < 12 || readTag(view, 0) !== "RIFF" || readTag(view, 8) !== "WAVE") {
    throw new Error("The file is not a RIFF/WAVE audio file.");
  }

  let format: WavFormat | null = null;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const id = readTag(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + size > view.byteLength) throw new Error("WAV fmt chunk is truncated.");
      format = parseFormat(view, body, size);
    } else if (id === "data") {
      if (!format) throw new Error("WAV data appears before its fmt chunk.");
      const available = Math.min(size, view.byteLength - body);
      const frameCount = Math.floor(available / format.blockAlign);
      const bytesPerSample = format.bitsPerSample / 8;
      const channels = Array.from({ length: format.channelCount }, () => new Float32Array(frameCount));
      for (let frame = 0; frame < frameCount; frame += 1) {
        const frameOffset = body + frame * format.blockAlign;
        for (let channel = 0; channel < format.channelCount; channel += 1) {
          channels[channel][frame] = readSample(view, frameOffset + channel * bytesPerSample, format);
        }
      }
      return {
        sampleRate: format.sampleRate,
        channels,
        bitsPerSample: format.bitsPerSample,
        formatCode: format.formatCode,
      };
    }
    // RIFF chunks are padded to an even size.
    offset = body + size + (size % 2);
  }
  throw new Error("The WAV file has no audio data.");
}

/** Encode mono samples as 16-bit PCM WAV bytes (clamped to [-1, 1]). */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const header = new Uint8Array(buildWavHeader(samples.length, sampleRate, "pcm16", 1));
  const output = new Uint8Array(header.byteLength + samples.length * 2);
  output.set(header, 0);
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Number.isFinite(samples[index]) ? samples[index] : 0;
    view.setInt16(header.byteLength + index * 2, floatToPcm16Sample(value), true);
  }
  return output;
}

/** Copy bytes into a standalone ArrayBuffer (safe to store or transfer). */
export function toStandaloneArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
