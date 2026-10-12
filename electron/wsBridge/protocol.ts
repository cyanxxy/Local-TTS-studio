import { errorMessage } from "../errors";
import { isRecord } from "../guards";
import { BRIDGE_RESULT_PREFIX, parseBridgeFailureLine } from "../localTtsIpc";

/**
 * The wire protocol between Electron and the Rust local bridge (`serve-ws`):
 * the startup lines on stdout, the request envelopes Electron sends and the
 * frames it accepts back. Everything here is pure; the limits that must agree
 * with the Rust side are held to it by electron/localTtsProtocolParity.test.ts.
 */

export const BRIDGE_PORT_PREFIX = "__PORT__";
export const MAX_PORT_ANNOUNCEMENT_BUFFER_BYTES = 64 * 1024;

// Mirror the Rust protocol ceiling so one binary frame is at most 1 MiB of
// Float32 data. Inter-unit silence is currently 0.2 seconds; one second at the
// highest accepted rate leaves ample headroom without permitting a large
// renderer-side allocation from metadata alone.
export const MAX_AUDIO_CHUNK_SAMPLES = 262_144;
export const MAX_AUDIO_SILENCE_SAMPLES = 192_000;
export const MAX_REQUEST_AUDIO_CHUNKS = 10_000;
export const DEFAULT_MAX_REQUEST_AUDIO_BYTES = 256 * 1024 * 1024;
// Stay strictly under the bridge's 64 MiB frame ceiling so an oversize request
// fails here, with a message naming the limit, instead of tripping the server's
// frame-size abort and surfacing as an unexplained transport close. The largest
// real payload is a 60,000,000-byte reference-audio base64 string plus its
// bounded JSON envelope, which clears this with room to spare.
export const DEFAULT_MAX_REQUEST_TEXT_BYTES = 63 * 1024 * 1024;
export const MIN_AUDIO_SAMPLE_RATE = 8_000;
export const MAX_AUDIO_SAMPLE_RATE = 192_000;

/** Bridge commands that return a result frame without streamed audio. */
export type BridgeCommand = "warm";

export interface WebSocketAudioChunk {
  requestId: string;
  index: number;
  total: number;
  sampleRate: number;
  sampleCount: number;
  silenceAfterSamples: number;
  textUnitIndex?: number;
  textUnitTotal?: number;
  audio: ArrayBuffer;
}

/** The `type` of the frame that reports the silence after a finished text unit. */
export const UNIT_GAP_MESSAGE_TYPE = "unit_gap";
/** The fields of a `unit_gap` frame besides `type`; electron/localTtsProtocolParity.test.ts holds them to the Rust frame. */
export const UNIT_GAP_FIELDS = ["requestId", "sampleRate", "textUnitIndex", "textUnitTotal", "silenceSamples"] as const;

/**
 * Silence the bridge inserts after a text unit's last audio chunk. It is
 * declared on its own frame so no chunk has to wait for its successor to learn
 * whether it is the unit's last. `afterChunkIndex` is the stream position the
 * validator assigned: the gap belongs after the audio chunk with that index.
 */
export interface WebSocketUnitGap {
  requestId: string;
  afterChunkIndex: number;
  sampleRate: number;
  silenceSamples: number;
  textUnitIndex: number;
  textUnitTotal: number;
}

// Metadata for a chunk whose binary frame has not arrived yet. Audio is always
// little-endian Float32: the bridge never negotiates another encoding, and
// exports (wav-f32, wav-pcm24) need the full precision end to end.
export type AudioChunkMetadata = Omit<WebSocketAudioChunk, "audio">;

/** A text frame that passed the envelope checks every frame must meet. */
export type BridgeMessage = Record<string, unknown> & { type: string };

export function dataToText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
  }
  return String(data);
}

/** The bytes of a binary frame, or null for a text frame. */
export function dataToArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy.buffer;
  }
  return null;
}

/** The port in a `__PORT__<port>` startup line, or null for any other line. */
export function parsePortAnnouncement(line: string): number | null {
  if (!line.startsWith(BRIDGE_PORT_PREFIX)) return null;
  const port = Number(line.slice(BRIDGE_PORT_PREFIX.length).trim());
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Rust local bridge announced an invalid WebSocket port.");
  }
  return port;
}

/** The failure in a `__RESULT__` startup line, or null for any other line. */
export function parseStartupFailure(line: string): Error | null {
  if (!line.startsWith(BRIDGE_RESULT_PREFIX)) return null;
  const message = parseBridgeFailureLine(line);
  if (message === null) return new Error("Rust local bridge returned an invalid startup result.");
  return new Error(message || "Rust local bridge reported a startup failure.");
}

/**
 * Serializes a request envelope, refusing one the bridge's frame ceiling would
 * reject with an unexplained close.
 */
export function encodeRequest(
  requestId: string,
  command: BridgeCommand | undefined,
  payload: Record<string, unknown>,
  maxBytes: number,
): string {
  const body = JSON.stringify({
    requestId,
    ...(command != null ? { command } : {}),
    payload,
  });
  if (Buffer.byteLength(body, "utf-8") > maxBytes) {
    throw new Error(`request exceeds the ${maxBytes}-byte WebSocket text limit`);
  }
  return body;
}

export function encodeCancel(requestId: string): string {
  return JSON.stringify({ command: "cancel", requestId });
}

export const SHUTDOWN_COMMAND = JSON.stringify({ command: "shutdown" });

/** Parses a text frame and checks the envelope every frame shares. */
export function parseBridgeMessage(data: unknown): BridgeMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataToText(data));
  } catch (err) {
    throw new Error(`Failed parsing WebSocket bridge message: ${errorMessage(err)}`);
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new Error("WebSocket bridge returned an invalid message.");
  }
  return parsed as BridgeMessage;
}

/**
 * Whether `message` is the bridge's terminal result for `requestId`. Used while
 * draining a cancelled request, where every other frame is dropped.
 */
export function isTerminalResultFor(data: unknown, requestId: string): boolean {
  if (dataToArrayBuffer(data)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataToText(data));
  } catch {
    return false;
  }
  return isRecord(parsed) && parsed.type === "result" && parsed.requestId === requestId;
}

function readCount(parsed: Record<string, unknown>, field: string): number {
  const value = parsed[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`WebSocket bridge returned invalid audio chunk \`${field}\`.`);
  }
  return value;
}

/** Validates an `audio_chunk` frame on its own; stream-level rules live in AudioStreamValidator. */
export function parseAudioChunkMetadata(parsed: Record<string, unknown>, requestId: string): AudioChunkMetadata {
  const index = readCount(parsed, "index");
  const total = readCount(parsed, "total");
  const sampleRate = readCount(parsed, "sampleRate");
  const sampleCount = readCount(parsed, "sampleCount");
  const silenceAfterSamples = readCount(parsed, "silenceAfterSamples");
  if (total > 0 && index >= total) {
    throw new Error("WebSocket bridge returned an audio chunk index outside the declared total.");
  }
  if (index >= MAX_REQUEST_AUDIO_CHUNKS || total > MAX_REQUEST_AUDIO_CHUNKS) {
    throw new Error("WebSocket bridge returned too many audio chunks.");
  }
  if (
    sampleRate < MIN_AUDIO_SAMPLE_RATE
    || sampleRate > MAX_AUDIO_SAMPLE_RATE
    || sampleCount <= 0
  ) {
    throw new Error("WebSocket bridge returned an audio chunk with invalid sample metadata.");
  }
  if (sampleCount > MAX_AUDIO_CHUNK_SAMPLES) {
    throw new Error("WebSocket bridge returned an audio chunk exceeding the maximum sample count.");
  }
  if (silenceAfterSamples > MAX_AUDIO_SILENCE_SAMPLES) {
    throw new Error("WebSocket bridge returned an audio chunk with excessive trailing silence.");
  }
  if (parsed.encoding !== undefined) {
    throw new Error("WebSocket bridge returned an audio chunk with an unsupported encoding.");
  }
  const hasTextUnitIndex = parsed.textUnitIndex !== undefined;
  const hasTextUnitTotal = parsed.textUnitTotal !== undefined;
  if (hasTextUnitIndex !== hasTextUnitTotal) {
    throw new Error("WebSocket bridge returned incomplete text-unit metadata.");
  }
  let textUnitMetadata: Pick<AudioChunkMetadata, "textUnitIndex" | "textUnitTotal"> = {};
  if (hasTextUnitIndex) {
    const textUnitIndex = parsed.textUnitIndex;
    const textUnitTotal = parsed.textUnitTotal;
    if (
      typeof textUnitIndex !== "number"
      || typeof textUnitTotal !== "number"
      || !Number.isSafeInteger(textUnitIndex)
      || !Number.isSafeInteger(textUnitTotal)
      || textUnitIndex < 0
      || textUnitTotal <= 0
      || textUnitIndex >= textUnitTotal
      || textUnitTotal > MAX_REQUEST_AUDIO_CHUNKS
    ) {
      throw new Error("WebSocket bridge returned invalid text-unit metadata.");
    }
    textUnitMetadata = { textUnitIndex, textUnitTotal };
  }
  return {
    requestId,
    index,
    total,
    sampleRate,
    sampleCount,
    silenceAfterSamples,
    ...textUnitMetadata,
  };
}

/** Validates a `unit_gap` frame on its own; stream-level rules live in AudioStreamValidator. */
export function parseUnitGapMetadata(
  parsed: Record<string, unknown>,
  requestId: string,
): Omit<WebSocketUnitGap, "afterChunkIndex"> {
  const field = (name: string): number => {
    const value = parsed[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`WebSocket bridge returned invalid unit gap \`${name}\`.`);
    }
    return value;
  };
  const sampleRate = field("sampleRate");
  const silenceSamples = field("silenceSamples");
  const textUnitIndex = field("textUnitIndex");
  const textUnitTotal = field("textUnitTotal");
  if (sampleRate < MIN_AUDIO_SAMPLE_RATE || sampleRate > MAX_AUDIO_SAMPLE_RATE) {
    throw new Error("WebSocket bridge returned a unit gap with an invalid sample rate.");
  }
  if (silenceSamples <= 0 || silenceSamples > MAX_AUDIO_SILENCE_SAMPLES) {
    throw new Error("WebSocket bridge returned a unit gap with invalid silence.");
  }
  if (textUnitTotal <= 0 || textUnitTotal > MAX_REQUEST_AUDIO_CHUNKS || textUnitIndex >= textUnitTotal) {
    throw new Error("WebSocket bridge returned invalid text-unit metadata.");
  }
  return { requestId, sampleRate, silenceSamples, textUnitIndex, textUnitTotal };
}

/** The audio summary of a successful generation result. */
export function parseResultAudioMetadata(parsed: Record<string, unknown>): { audioChunkCount: number; sampleRate: number } {
  if (!isRecord(parsed.result)) {
    throw new Error("WebSocket bridge returned a successful result without a result object.");
  }
  const audioChunkCount = parsed.result.audioChunkCount;
  if (
    typeof audioChunkCount !== "number"
    || !Number.isSafeInteger(audioChunkCount)
    || audioChunkCount <= 0
  ) {
    throw new Error("WebSocket bridge returned a successful result with an invalid audio chunk count.");
  }
  const sampleRate = parsed.result.sampleRate;
  if (
    typeof sampleRate !== "number"
    || !Number.isSafeInteger(sampleRate)
    || sampleRate < MIN_AUDIO_SAMPLE_RATE
    || sampleRate > MAX_AUDIO_SAMPLE_RATE
  ) {
    throw new Error("WebSocket bridge returned a successful result with an invalid sample rate.");
  }
  return { audioChunkCount, sampleRate };
}
