import {
  parseAudioChunkMetadata,
  parseResultAudioMetadata,
  type AudioChunkMetadata,
  type WebSocketAudioChunk,
} from "./protocol";

export interface AudioStreamLimits {
  /** Cap on the samples one request may stream, trailing silence included. */
  maxRequestAudioSamples: number;
  /** The same cap in bytes, for the error message. */
  maxRequestAudioBytes: number;
}

const UNEXPECTED_COMMAND_AUDIO = "WebSocket bridge returned unexpected audio for a command request.";

/**
 * The per-request rules of the audio stream: each `audio_chunk` frame is
 * followed by exactly its binary frame, indexes run 0, 1, 2… without gaps, the
 * sample rate and any declared total never change, the request stays under its
 * audio budget, and the final result agrees with what was streamed. Every
 * method throws an Error whose message is the protocol failure to report.
 */
export class AudioStreamValidator {
  readonly #requestId: string;
  readonly #expectAudio: boolean;
  readonly #limits: AudioStreamLimits;
  #pending: AudioChunkMetadata | null = null;
  #nextIndex = 0;
  #declaredTotal: number | null = null;
  #sampleRate: number | null = null;
  #outputSamples = 0;

  constructor(requestId: string, expectAudio: boolean, limits: AudioStreamLimits) {
    this.#requestId = requestId;
    this.#expectAudio = expectAudio;
    this.#limits = limits;
  }

  /** True between an `audio_chunk` frame and its binary frame. */
  get hasPendingChunk(): boolean {
    return this.#pending !== null;
  }

  /** Chunks whose audio has been accepted so far. */
  get chunkCount(): number {
    return this.#nextIndex;
  }

  acceptMetadata(parsed: Record<string, unknown>): void {
    if (!this.#expectAudio) throw new Error(UNEXPECTED_COMMAND_AUDIO);
    if (this.#pending) {
      throw new Error("WebSocket bridge returned audio chunk metadata before the pending binary frame.");
    }
    const metadata = parseAudioChunkMetadata(parsed, this.#requestId);
    if (
      metadata.sampleCount + metadata.silenceAfterSamples
      > this.#limits.maxRequestAudioSamples - this.#outputSamples
    ) {
      throw new Error(
        `WebSocket bridge audio exceeded the ${this.#limits.maxRequestAudioBytes}-byte request limit.`,
      );
    }
    if (this.#declaredTotal != null && metadata.total > 0 && metadata.total !== this.#declaredTotal) {
      throw new Error("WebSocket bridge changed the audio chunk total mid-stream.");
    }
    // Every index below the next one has already been accepted in order.
    if (metadata.index < this.#nextIndex) {
      throw new Error("WebSocket bridge returned a duplicate audio chunk index.");
    }
    if (metadata.index !== this.#nextIndex) {
      throw new Error("WebSocket bridge returned audio chunks out of sequence.");
    }
    if (this.#sampleRate != null && metadata.sampleRate !== this.#sampleRate) {
      throw new Error("WebSocket bridge changed the audio sample rate mid-stream.");
    }
    this.#sampleRate = metadata.sampleRate;
    if (metadata.total > 0) this.#declaredTotal = metadata.total;
    this.#pending = metadata;
  }

  /** Pairs a binary frame with its metadata and returns the finished chunk. */
  acceptBinary(audio: ArrayBuffer): WebSocketAudioChunk {
    if (!this.#expectAudio) throw new Error(UNEXPECTED_COMMAND_AUDIO);
    const metadata = this.#pending;
    this.#pending = null;
    if (!metadata) {
      throw new Error("WebSocket bridge returned an audio binary frame without metadata.");
    }
    if (audio.byteLength !== metadata.sampleCount * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error("WebSocket bridge returned an audio binary frame with an unexpected byte length.");
    }
    this.#nextIndex += 1;
    this.#outputSamples += metadata.sampleCount + metadata.silenceAfterSamples;
    return { ...metadata, audio };
  }

  /** Checks a successful (`ok: true`) result against the streamed audio. */
  verifyResult(parsed: Record<string, unknown>): void {
    if (!this.#expectAudio) return;
    const expected = parseResultAudioMetadata(parsed);
    if (
      expected.audioChunkCount !== this.#nextIndex
      || (this.#declaredTotal != null && expected.audioChunkCount !== this.#declaredTotal)
    ) {
      throw new Error("WebSocket bridge result did not match the streamed audio chunk count.");
    }
    if (this.#sampleRate != null && expected.sampleRate !== this.#sampleRate) {
      throw new Error("WebSocket bridge result did not match the streamed audio sample rate.");
    }
  }
}
