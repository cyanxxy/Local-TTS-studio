/**
 * Piper worker: VITS voices from the curated catalog (src/lib/piperVoices.ts),
 * one onnxruntime-web WASM session at a time. A voice's graph (60-135 MB) and
 * config download the first time it is asked for, are verified against the
 * pinned catalog and cached; LOAD makes the preferred (or default) voice ready
 * and a GENERATE with another voice switches to it before synthesizing, reporting
 * the download like LOAD and stopping it when the generation is superseded or aborted.
 *
 * WASM only: VITS runs faster than real time on a few CPU threads
 * (RTF 0.04-0.06 measured on 4 threads), and WebGPU has no kernels for part of
 * the graph.
 */
import type { WorkerInMessage } from "../types";
import { loadEspeakPhonemizer, type EspeakPhonemize } from "../lib/espeakPhonemizer";
import { PHONEMIZER_MODULE_URL } from "../lib/onnxWasmAssets";
import { chunkPiperText, parsePiperConfig, PiperRuntime, resolvePiperSpeaker, type PiperVoiceConfig } from "../lib/piperRuntime";
import { PIPER_CACHE_NAME, PIPER_VOICES, resolvePiperVoice, type PiperVoiceEntry } from "../lib/piperVoices";
import {
  deletePinnedAssetCache,
  fetchPinnedAsset,
  pinnedAssetSizes,
  prunePinnedAssetCache,
} from "../lib/pinnedModelAssets";
import { configureStyleTtsWasm, createStyleTtsSession, releaseStyleTtsSession, type StyleTtsSession } from "../lib/styleTtsRuntime";
import type { LoadProgress } from "./kit/progress";
import { startPhonemeWorker, type PhonemeEngine } from "./kit/phonemeWorker";
import { PIPER_CATALOG } from "./manifests/piperVoices";

const LABEL = "Piper";
const WARM_UP_TEXT = "Hello.";

interface LoadedVoice {
  id: string;
  runtime: PiperRuntime;
  config: PiperVoiceConfig;
}

function voiceFiles(voice: PiperVoiceEntry): string[] {
  return [voice.model, voice.config];
}

/** Downloads, verifies and opens voices; keeps only the one in use. */
function createVoiceHost(phonemize: EspeakPhonemize) {
  let current: LoadedVoice | null = null;

  async function open(voice: PiperVoiceEntry, progress?: LoadProgress, signal?: AbortSignal): Promise<LoadedVoice> {
    const fetchFile = (file: string) => fetchPinnedAsset(PIPER_CATALOG, file, { cacheName: PIPER_CACHE_NAME, label: LABEL, progress, signal });
    const [modelBuffer, configBuffer] = await Promise.all([fetchFile(voice.model), fetchFile(voice.config)]);
    const config = parsePiperConfig(configBuffer);
    let session: StyleTtsSession | null = null;
    try {
      session = await createStyleTtsSession(modelBuffer, "wasm");
      const runtime = new PiperRuntime(session, config, phonemize);
      await runtime.synthesize(WARM_UP_TEXT, 0, 1);
      return { id: voice.id, runtime, config };
    } catch (error) {
      await releaseStyleTtsSession(session);
      throw error;
    }
  }

  return {
    /** The voice's runtime, opening it (and closing the previous voice) when it is not the current one. */
    async use(voice: PiperVoiceEntry, progress?: LoadProgress, signal?: AbortSignal): Promise<LoadedVoice> {
      if (current?.id === voice.id) return current;
      const opened = await open(voice, progress, signal);
      if (signal?.aborted) {
        await opened.runtime.dispose().catch(() => undefined);
        throw signal.reason;
      }
      const previous = current;
      current = opened;
      await previous?.runtime.dispose().catch(() => undefined);
      return opened;
    },
    isCurrent: (voice: PiperVoiceEntry) => current?.id === voice.id,
    async dispose(): Promise<void> {
      const previous = current;
      current = null;
      await previous?.runtime.dispose();
    },
  };
}

const engine: PhonemeEngine = {
  label: LABEL,
  expectedBytes: ({ preferredVoice }) => (
    pinnedAssetSizes(PIPER_CATALOG, voiceFiles(resolvePiperVoice(preferredVoice ?? "").voice))
  ),
  async load(progress, { preferredVoice }) {
    configureStyleTtsWasm();
    const phonemize = await loadEspeakPhonemizer(PHONEMIZER_MODULE_URL);
    const voices = createVoiceHost(phonemize);
    try {
      await voices.use(resolvePiperVoice(preferredVoice ?? "").voice, progress);
    } catch (error) {
      await voices.dispose().catch(() => undefined);
      throw error;
    }
    void prunePinnedAssetCache(PIPER_CACHE_NAME, [PIPER_CATALOG]);
    return {
      backend: "wasm",
      voices: PIPER_VOICES.map((voice) => voice.id),
      sampleRate: 22_050,
      planChunks: chunkPiperText,
      pendingDownloadBytes(voiceValue) {
        const { voice } = resolvePiperVoice(voiceValue);
        return voices.isCurrent(voice) ? {} : pinnedAssetSizes(PIPER_CATALOG, voiceFiles(voice));
      },
      async synthesize(text, voiceValue, speed, { progress, signal }) {
        const { voice, speaker } = resolvePiperVoice(voiceValue);
        const loaded = await voices.use(voice, progress, signal);
        const audio = await loaded.runtime.synthesize(text, resolvePiperSpeaker(loaded.config, speaker), speed);
        return { audio, sampleRate: loaded.runtime.sampleRate };
      },
      dispose: () => voices.dispose(),
    };
  },
  clearCache: () => deletePinnedAssetCache(PIPER_CACHE_NAME),
};

const runtime = startPhonemeWorker(engine);
self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  runtime.handleMessage(event.data);
};
