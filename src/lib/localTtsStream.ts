import type { LocalTtsAudioChunkEvent, LocalTtsAudioGapEvent, LocalTtsAudioStreamEvent } from "../electron";

/** One playable piece of a local bridge stream, in timeline order. */
export interface AssembledAudio {
  /** A decoded chunk, or the silence a text unit leaves after its last chunk. */
  kind: "audio" | "gap";
  /** Finite PCM; a gap's samples are all zero. */
  samples: Float32Array;
  sampleRate: number;
  /** The bridge chunk index; a gap carries the index of the chunk it follows. */
  chunkIndex: number;
  /** The chunk total the bridge declared, or 0 while it is still streaming. */
  declaredTotal: number;
  /** Which of the request's text units the piece belongs to, when the bridge says. */
  textUnitIndex?: number;
  textUnitTotal?: number;
  /** Silence that ends this piece, so a caption can stop where the speech does. */
  pauseAfterSec: number;
}

export interface LocalAudioAssembler {
  /** Takes a stream event; contiguous pieces are handed to `onAudio` at once. */
  accept: (event: LocalTtsAudioStreamEvent) => void;
  /** Replaces where pieces go, so a hook can keep one assembler while its callbacks change. */
  setSink: (onAudio: (part: AssembledAudio) => void) => void;
  /** Forgets the stream so far; call when a new request starts. */
  reset: () => void;
  /** How many distinct chunks have arrived, for checking against the bridge's `audioChunkCount`. */
  readonly receivedCount: number;
}

/** Whether a streamed chunk is well formed: some samples, and exactly that many bytes. */
export function isPlayableAudioChunk(event: Pick<LocalTtsAudioChunkEvent, "audio" | "sampleCount">): boolean {
  return event.sampleCount > 0 && event.audio.byteLength === event.sampleCount * Float32Array.BYTES_PER_ELEMENT;
}

/** The chunk's PCM with non-finite samples zeroed, followed by any silence the chunk itself declares. */
function playbackSamples(chunk: Pick<LocalTtsAudioChunkEvent, "audio" | "sampleCount" | "silenceAfterSamples">): Float32Array {
  const source = new Float32Array(chunk.audio, 0, chunk.sampleCount);
  const trailingSilence = Math.max(0, chunk.silenceAfterSamples);
  const output = new Float32Array(source.length + trailingSilence);
  for (let index = 0; index < source.length; index += 1) {
    const value = source[index];
    output[index] = Number.isFinite(value) ? value : 0;
  }
  return output;
}

/**
 * Puts a local bridge's audio stream back into timeline order: chunks arrive
 * out of band and are released only once every earlier chunk has, each gap
 * lands right after the chunk it follows, and the PCM is scrubbed of
 * non-finite samples exactly once. Every renderer consumer of the bridge
 * (the Qwen3 runtime hook, the synthesis stream and the local-runtime page)
 * shares this, so none of them can disagree about where silence goes.
 *
 * A chunk's own `silenceAfterSamples` (what bridges that predate `unit_gap`
 * frames send, and what NeuTTS leaves at zero) is still honoured: it is
 * appended to the chunk's samples.
 */
export function createLocalAudioAssembler(initialSink: (part: AssembledAudio) => void = () => undefined): LocalAudioAssembler {
  let onAudio = initialSink;
  const pendingChunks = new Map<number, LocalTtsAudioChunkEvent>();
  const pendingGaps = new Map<number, LocalTtsAudioGapEvent>();
  const received = new Set<number>();
  let nextIndex = 0;
  let sampleRate: number | null = null;
  let lastDeclaredTotal = 0;

  const reset = () => {
    pendingChunks.clear();
    pendingGaps.clear();
    received.clear();
    nextIndex = 0;
    sampleRate = null;
    lastDeclaredTotal = 0;
  };

  const emitGap = (gap: LocalTtsAudioGapEvent) => {
    onAudio({
      kind: "gap",
      samples: new Float32Array(gap.silenceSamples),
      sampleRate: gap.sampleRate,
      chunkIndex: gap.afterChunkIndex,
      declaredTotal: lastDeclaredTotal,
      textUnitIndex: gap.textUnitIndex,
      textUnitTotal: gap.textUnitTotal,
      pauseAfterSec: gap.silenceSamples / gap.sampleRate,
    });
  };

  const acceptChunk = (event: LocalTtsAudioChunkEvent) => {
    if (!isPlayableAudioChunk(event)) return;
    if (sampleRate !== event.sampleRate) {
      reset();
      sampleRate = event.sampleRate;
    }
    if (received.has(event.index)) return;
    received.add(event.index);
    pendingChunks.set(event.index, event);
    for (let chunk = pendingChunks.get(nextIndex); chunk; chunk = pendingChunks.get(nextIndex)) {
      pendingChunks.delete(nextIndex);
      const index = nextIndex++;
      lastDeclaredTotal = chunk.total;
      onAudio({
        kind: "audio",
        samples: playbackSamples(chunk),
        sampleRate: chunk.sampleRate,
        chunkIndex: index,
        declaredTotal: chunk.total,
        textUnitIndex: chunk.textUnitIndex,
        textUnitTotal: chunk.textUnitTotal,
        pauseAfterSec: chunk.silenceAfterSamples / chunk.sampleRate,
      });
      const gap = pendingGaps.get(index);
      if (gap) {
        pendingGaps.delete(index);
        emitGap(gap);
      }
    }
  };

  const acceptGap = (gap: LocalTtsAudioGapEvent) => {
    if (!(gap.silenceSamples > 0) || !(gap.sampleRate > 0) || gap.afterChunkIndex < 0) return;
    if (sampleRate !== null && gap.sampleRate !== sampleRate) return;
    // Its chunk is already out: the common case, as the bridge sends a gap
    // right after the unit's last chunk. Otherwise hold it for that chunk.
    if (gap.afterChunkIndex < nextIndex) emitGap(gap);
    else pendingGaps.set(gap.afterChunkIndex, gap);
  };

  return {
    accept: (event) => {
      if (event.kind === "gap") acceptGap(event);
      else acceptChunk(event);
    },
    setSink: (sink) => {
      onAudio = sink;
    },
    reset,
    get receivedCount() {
      return received.size;
    },
  };
}
