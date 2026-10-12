/**
 * A throwaway player for auditioning a take or a dialogue without touching the
 * shared player: one buffer at a time, started and stopped on demand. Starting
 * another stops the first.
 */

export interface AuditionAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface AuditionPlayer {
  /** Plays `audio`; `onEnded` runs when it finishes or is stopped, once. */
  play: (audio: AuditionAudio, onEnded?: () => void) => Promise<void>;
  stop: () => void;
  dispose: () => void;
}

type AudioContextFactory = () => AudioContext;

function defaultContextFactory(): AudioContext {
  const Context = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) throw new Error("Audio playback is not available in this environment.");
  return new Context();
}

export function createAuditionPlayer(createContext: AudioContextFactory = defaultContextFactory): AuditionPlayer {
  let context: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let finish: (() => void) | null = null;

  const stop = () => {
    const current = source;
    const done = finish;
    source = null;
    finish = null;
    if (current) {
      current.onended = null;
      try {
        current.stop();
      } catch {
        // Already stopped.
      }
      current.disconnect();
    }
    done?.();
  };

  return {
    play: async (audio, onEnded) => {
      stop();
      if (audio.samples.length === 0) {
        onEnded?.();
        return;
      }
      context ??= createContext();
      if (context.state === "suspended") await context.resume();
      const buffer = context.createBuffer(1, audio.samples.length, audio.sampleRate);
      buffer.copyToChannel(audio.samples as Float32Array<ArrayBuffer>, 0);
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      let ended = false;
      const done = () => {
        if (ended) return;
        ended = true;
        onEnded?.();
      };
      node.onended = () => {
        if (source === node) {
          source = null;
          finish = null;
        }
        done();
      };
      source = node;
      finish = done;
      node.start();
    },
    stop,
    dispose: () => {
      stop();
      const closing = context;
      context = null;
      if (closing && closing.state !== "closed") void closing.close().catch(() => undefined);
    },
  };
}
